// Embedded browsers are child Webviews attached to the main window, each
// owned by one right-panel tab and positioned by the frontend.
// Navigations are reported back via "browser:navigated" events.

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl, Wry,
};
#[cfg(target_os = "windows")]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX, COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE,
    COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT,
};
#[cfg(target_os = "windows")]
use webview2_com::{
    take_pwstr, CoTaskMemPWSTR, ExecuteScriptCompletedHandler, GetCookiesCompletedHandler,
};
#[cfg(target_os = "windows")]
use windows_core::{Interface, BOOL, PCWSTR, PWSTR};

static BROWSERS: LazyLock<Mutex<HashMap<String, Webview<Wry>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PREVIEW_FILES: LazyLock<Mutex<Vec<PathBuf>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static PREVIEW_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn open_preview_external(app: &AppHandle, html: &str) -> Result<(), String> {
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let (path, mut file) = loop {
        let sequence = PREVIEW_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(
            "qone-preview-{}-{sequence}.html",
            std::process::id()
        ));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => break (path, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    };
    let result = file
        .write_all(html.as_bytes())
        .map_err(|error| error.to_string())
        .and_then(|_| {
            drop(file);
            tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|error| error.to_string())
        });
    if result.is_ok() {
        if let Ok(mut files) = PREVIEW_FILES.lock() {
            files.push(path);
        }
    } else {
        let _ = std::fs::remove_file(path);
    }
    result
}

pub fn cleanup_external_previews() {
    if let Ok(mut files) = PREVIEW_FILES.lock() {
        for path in files.drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn with_browser<T: Clone, R>(
    browsers: &Mutex<HashMap<String, T>>,
    browser_id: &str,
    f: impl FnOnce(&T) -> Result<R, String>,
) -> Result<R, String> {
    // Never hold the registry lock while dispatching to the UI thread or waiting
    // for a callback: close/resize must remain available during cookie capture.
    let webview = browsers
        .lock()
        .map_err(|e| e.to_string())?
        .get(browser_id)
        .cloned()
        .ok_or("browser not open")?;
    f(&webview)
}

#[cfg(target_os = "windows")]
const CALLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[cfg(target_os = "windows")]
fn wait_for_callback<T>(
    receiver: std::sync::mpsc::Receiver<Result<T, String>>,
    timeout: std::time::Duration,
) -> Result<T, String> {
    // with_webview runs the callback on Tauri's UI thread. This worker has no
    // Windows messages to pump; a channel send must wake it directly.
    receiver
        .recv_timeout(timeout)
        .map_err(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => {
                "Browser operation timed out; please retry.".to_string()
            }
            std::sync::mpsc::RecvTimeoutError::Disconnected => {
                "Browser closed before the operation completed.".to_string()
            }
        })?
}

fn place(webview: &Webview<Wry>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(x, y))
        .and_then(|_| webview.set_size(LogicalSize::new(w, h)))
        .map_err(|e| e.to_string())
}

pub fn open(
    app: &AppHandle,
    browser_id: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    initialization_script: Option<&str>,
) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    {
        let existing = BROWSERS
            .lock()
            .map_err(|e| e.to_string())?
            .get(browser_id)
            .cloned();
        if let Some(webview) = existing {
            webview.navigate(target).map_err(|e| e.to_string())?;
            webview.hide().map_err(|e| e.to_string())?;
            return place(&webview, x, y, w, h);
        }
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let app2 = app.clone();
    let navigation_id = browser_id.to_owned();
    let label = format!("dock-browser-{browser_id}");
    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(target))
        .data_directory(crate::data_paths::webview()?)
        .devtools(false)
        .on_navigation(move |next| {
            let _ = app2.emit(
                "browser:navigated",
                serde_json::json!({ "browserId": navigation_id.clone(), "url": next.as_str() }),
            );
            true
        });
    if let Some(script) = initialization_script {
        builder = builder.initialization_script(script);
    }
    let webview = window
        // Do not expose a hit-test surface until the frontend owner has checked
        // whether a menu is open or this mount was disposed during creation.
        .add_child(
            builder,
            LogicalPosition::new(-32000.0, -32000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    BROWSERS
        .lock()
        .map_err(|e| e.to_string())?
        .insert(browser_id.to_owned(), webview.clone());
    webview.hide().map_err(|e| e.to_string())?;
    place(&webview, x, y, w, h)?;
    Ok(())
}

pub fn navigate(browser_id: &str, url: &str) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    with_browser(&BROWSERS, browser_id, |webview| {
        webview.navigate(target.clone()).map_err(|e| e.to_string())
    })
}

#[cfg(target_os = "windows")]
// Tauri rejects top-level data URLs by default; load generated previews into
// the existing child WebView2 instead of navigating to a data URL.
pub fn preview(browser_id: &str, html: String) -> Result<(), String> {
    with_browser(&BROWSERS, browser_id, |webview| {
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        webview
            .with_webview(move |platform| {
                let result = (|| -> Result<(), String> {
                    let core = unsafe { platform.controller().CoreWebView2() }
                        .map_err(|e| e.to_string())?;
                    let source = CoTaskMemPWSTR::from(html.as_str());
                    unsafe { core.NavigateToString(*source.as_ref().as_pcwstr()) }
                        .map_err(|e| e.to_string())
                })();
                let _ = sender.send(result);
            })
            .map_err(|e| e.to_string())?;
        wait_for_callback(receiver, CALLBACK_TIMEOUT)
    })
}

#[cfg(not(target_os = "windows"))]
pub fn preview(_browser_id: &str, _html: String) -> Result<(), String> {
    Err("code preview requires WebView2".into())
}

pub fn bounds(browser_id: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with_browser(&BROWSERS, browser_id, |webview| place(webview, x, y, w, h))
}

pub fn set_visible(browser_id: &str, visible: bool) -> Result<(), String> {
    with_browser(&BROWSERS, browser_id, |webview| {
        if visible {
            webview.show().map_err(|e| e.to_string())
        } else {
            // Hiding alone is not enough on Windows: the child HWND that hosts
            // the WebView2 can keep swallowing pointer input over its last
            // rect. Collapse it and park it offscreen so nothing can hit it.
            let _ = webview.set_size(LogicalSize::new(0.0, 0.0));
            let _ = webview.set_position(LogicalPosition::new(-32000.0, -32000.0));
            webview.hide().map_err(|e| e.to_string())
        }
    })
}

pub fn eval(browser_id: &str, script: &str) -> Result<(), String> {
    with_browser(&BROWSERS, browser_id, |webview| {
        webview.eval(script).map_err(|e| e.to_string())
    })
}

#[cfg(target_os = "windows")]
pub fn eval_result(browser_id: &str, script: &str) -> Result<String, String> {
    with_browser(&BROWSERS, browser_id, |webview| {
        let (sender, receiver) = std::sync::mpsc::channel();
        let script = script.to_owned();
        webview
            .with_webview(move |platform| {
                let error_sender = sender.clone();
                let result = (|| -> Result<(), String> {
                    let core = unsafe { platform.controller().CoreWebView2() }
                        .map_err(|error| error.to_string())?;
                    let handler = ExecuteScriptCompletedHandler::create(Box::new(
                        move |error_code, result| {
                            let value = error_code
                                .map(|_| result.to_string())
                                .map_err(|error| error.to_string());
                            let _ = sender.send(value);
                            Ok(())
                        },
                    ));
                    let source = CoTaskMemPWSTR::from(script.as_str());
                    unsafe { core.ExecuteScript(*source.as_ref().as_pcwstr(), &handler) }
                        .map_err(|error| error.to_string())
                })();
                if let Err(error) = result {
                    let _ = error_sender.send(Err(error));
                }
            })
            .map_err(|error| error.to_string())?;
        wait_for_callback(receiver, CALLBACK_TIMEOUT)
    })
}

#[cfg(not(target_os = "windows"))]
pub fn eval_result(_browser_id: &str, _script: &str) -> Result<String, String> {
    Err("browser script results are only supported on Windows WebView2".into())
}

#[cfg(target_os = "windows")]
fn read_cookie(
    cookie: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Cookie,
) -> Result<crate::auth_files::AuthCookie, String> {
    unsafe {
        let mut name = PWSTR::null();
        cookie.Name(&mut name).map_err(|e| e.to_string())?;
        let mut value = PWSTR::null();
        cookie.Value(&mut value).map_err(|e| e.to_string())?;
        let mut domain = PWSTR::null();
        cookie.Domain(&mut domain).map_err(|e| e.to_string())?;
        let mut path = PWSTR::null();
        cookie.Path(&mut path).map_err(|e| e.to_string())?;
        let mut expires = 0.0;
        cookie.Expires(&mut expires).map_err(|e| e.to_string())?;
        let mut http_only = BOOL::default();
        cookie
            .IsHttpOnly(&mut http_only)
            .map_err(|e| e.to_string())?;
        let mut secure = BOOL::default();
        cookie.IsSecure(&mut secure).map_err(|e| e.to_string())?;
        let mut session = BOOL::default();
        cookie.IsSession(&mut session).map_err(|e| e.to_string())?;
        let mut same_site = COREWEBVIEW2_COOKIE_SAME_SITE_KIND_LAX;
        cookie.SameSite(&mut same_site).map_err(|e| e.to_string())?;
        let same_site = match same_site {
            COREWEBVIEW2_COOKIE_SAME_SITE_KIND_STRICT => "strict",
            COREWEBVIEW2_COOKIE_SAME_SITE_KIND_NONE => "none",
            _ => "lax",
        };

        Ok(crate::auth_files::AuthCookie {
            name: take_pwstr(name),
            value: take_pwstr(value),
            domain: take_pwstr(domain),
            path: take_pwstr(path),
            expires: (expires >= 0.0).then_some(expires),
            http_only: http_only.as_bool(),
            secure: secure.as_bool(),
            same_site: same_site.into(),
            session: session.as_bool(),
        })
    }
}

#[cfg(target_os = "windows")]
fn cookie_domain_matches(cookie_domain: &str, target_host: &str) -> bool {
    let cookie_domain = cookie_domain
        .trim()
        .trim_start_matches('.')
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let target_host = target_host
        .trim()
        .trim_end_matches('.')
        .to_ascii_lowercase();

    !cookie_domain.is_empty()
        && !target_host.is_empty()
        && (target_host == cookie_domain || target_host.ends_with(&format!(".{cookie_domain}")))
}

#[cfg(target_os = "windows")]
pub fn cookies(browser_id: &str, url: &str) -> Result<Vec<crate::auth_files::AuthCookie>, String> {
    #[cfg(debug_assertions)]
    crate::dev_network::log("Cookie capture: dispatching to UI thread");
    let result = with_browser(&BROWSERS, browser_id, |webview| {
        let (sender, receiver) = std::sync::mpsc::channel();
        let target_host = Url::parse(url)
            .map_err(|error| error.to_string())?
            .host_str()
            .ok_or_else(|| "cookie capture URL has no host".to_string())?
            .to_owned();
        webview
            .with_webview(move |platform| {
                #[cfg(debug_assertions)]
                crate::dev_network::log("Cookie capture: requesting WebView2 cookies");
                let error_sender = sender.clone();
                let result = (|| -> Result<(), String> {
                    let core = unsafe { platform.controller().CoreWebView2() }
                        .map_err(|e| e.to_string())?
                        .cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2>()
                        .map_err(|e| e.to_string())?;
                    let manager = unsafe { core.CookieManager() }.map_err(|e| e.to_string())?;
                    let target_host = target_host.clone();
                    let handler =
                        GetCookiesCompletedHandler::create(Box::new(move |error_code, list| {
                            let result =
                                (|| -> Result<Vec<crate::auth_files::AuthCookie>, String> {
                                    error_code.map_err(|e| e.to_string())?;
                                    let list =
                                        list.ok_or_else(|| "cookie list unavailable".to_string())?;
                                    let mut count = 0;
                                    unsafe { list.Count(&mut count) }.map_err(|e| e.to_string())?;
                                    let mut cookies = Vec::with_capacity(count as usize);
                                    let mut skipped = 0;
                                    for index in 0..count {
                                        let cookie = unsafe { list.GetValueAtIndex(index) }
                                            .map_err(|e| e.to_string())?;
                                        let mut cookie = read_cookie(&cookie)?;
                                        // Nameless entries cannot be sent in a Cookie header.
                                        // WebView2 may also expose an empty default path.
                                        if cookie.name.is_empty()
                                            || cookie.domain.is_empty()
                                            || cookie.name.len() > 256
                                            || cookie.value.len() > 65_536
                                            || cookie.domain.len() > 512
                                        {
                                            skipped += 1;
                                            continue;
                                        }
                                        if cookie.path.is_empty() {
                                            cookie.path = "/".into();
                                        }
                                        if cookie.path.len() > 4096 {
                                            skipped += 1;
                                            continue;
                                        }
                                        if cookie_domain_matches(&cookie.domain, &target_host) {
                                            cookies.push(cookie);
                                        }
                                    }
                                    #[cfg(debug_assertions)]
                                    crate::dev_network::log(&format!(
                                        "Cookie capture: host={target_host} total={count} matched={} skipped={skipped}",
                                        cookies.len()
                                    ));
                                    Ok(cookies)
                                })();
                            let _ = sender.send(result);
                            Ok(())
                        }));
                    // Export cookies for the target host across all paths; discard other domains.
                    unsafe { manager.GetCookies(PCWSTR::null(), &handler) }
                        .map_err(|e| e.to_string())
                })();
                if let Err(error) = result {
                    let _ = error_sender.send(Err(error));
                }
            })
            .map_err(|e| e.to_string())?;
        wait_for_callback(receiver, CALLBACK_TIMEOUT)
    });
    #[cfg(debug_assertions)]
    crate::dev_network::log(if result.is_ok() {
        "Cookie capture: completed"
    } else {
        "Cookie capture: failed or timed out"
    });
    result
}

#[cfg(not(target_os = "windows"))]
pub fn cookies(
    _browser_id: &str,
    _url: &str,
) -> Result<Vec<crate::auth_files::AuthCookie>, String> {
    Err("cookie capture only supported on Windows WebView2".into())
}

pub fn close(browser_id: &str) -> Result<(), String> {
    #[cfg(all(target_os = "windows", debug_assertions))]
    crate::dev_network::log("Browser close: requested");
    let webview = BROWSERS
        .lock()
        .map_err(|e| e.to_string())?
        .remove(browser_id);
    if let Some(webview) = webview {
        // Use the same complete shutdown sequence as browser_visible(false).
        // Hiding alone can leave the child HWND's old hit rectangle alive
        // until the asynchronous dispatcher finishes removing the webview.
        let _ = webview.set_size(LogicalSize::new(0.0, 0.0));
        let _ = webview.set_position(LogicalPosition::new(-32000.0, -32000.0));
        let _ = webview.hide();
        webview.close().map_err(|e| e.to_string())?;
    }
    #[cfg(all(target_os = "windows", debug_assertions))]
    crate::dev_network::log("Browser close: dispatched");
    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::{cookie_domain_matches, wait_for_callback, with_browser};
    use std::{
        collections::HashMap,
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };

    #[test]
    fn pending_capture_allows_close_and_receives_cross_thread_reply_without_windows_messages() {
        let browsers = Arc::new(Mutex::new(HashMap::from([("login".to_string(), ())])));
        let worker_browsers = browsers.clone();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (callback, receiver) = mpsc::channel();
        let (finished, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let capture = with_browser(&worker_browsers, "login", |_| {
                entered_tx.send(()).unwrap();
                wait_for_callback(receiver, Duration::from_secs(2))
            });
            finished.send(capture).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        // Simulate browser_close while capture waits for its UI-thread callback.
        let mut registry = browsers
            .try_lock()
            .expect("cookie capture blocks browser_close");
        assert!(registry.remove("login").is_some());
        drop(registry);
        callback.send(Ok(42)).unwrap();
        assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(42));
        worker.join().unwrap();
    }

    #[test]
    fn missing_callback_times_out_and_late_result_is_discarded() {
        let (sender, receiver) = mpsc::channel::<Result<(), String>>();
        assert!(wait_for_callback(receiver, Duration::ZERO)
            .unwrap_err()
            .contains("timed out"));
        assert!(sender.send(Ok(())).is_err());
        let (sender, receiver) = mpsc::channel::<Result<(), String>>();
        drop(sender);
        assert!(wait_for_callback(receiver, Duration::ZERO)
            .unwrap_err()
            .contains("closed"));
    }

    #[test]
    fn matches_parent_and_exact_cookie_domains() {
        assert!(cookie_domain_matches(".douyin.com", "www.douyin.com"));
        assert!(cookie_domain_matches("douyin.com", "douyin.com"));
        assert!(cookie_domain_matches(".WWW.DOUYIN.COM", "www.douyin.com"));
    }

    #[test]
    fn rejects_unrelated_or_suffix_spoofed_domains() {
        assert!(!cookie_domain_matches(
            ".douyin.com",
            "www.douyin.com.evil.test"
        ));
        assert!(!cookie_domain_matches(".other.test", "www.douyin.com"));
        assert!(!cookie_domain_matches("", "www.douyin.com"));
    }
}
