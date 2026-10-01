// Embedded browsers are child Webviews attached to the main window, each
// owned by one right-panel tab and positioned by the frontend.
// Navigations are reported back via "browser:navigated" events.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder,
    WebviewUrl, Wry,
};
#[cfg(target_os = "windows")]
use webview2_com::CoTaskMemPWSTR;

static BROWSERS: LazyLock<Mutex<HashMap<String, Webview<Wry>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static PREVIEW_FILES: LazyLock<Mutex<Vec<PathBuf>>> = LazyLock::new(|| Mutex::new(Vec::new()));
static PREVIEW_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn open_preview_external(app: &AppHandle, html: &str) -> Result<(), String> {
    let directory = app.path().app_cache_dir().map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let (path, mut file) = loop {
        let sequence = PREVIEW_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!("qone-preview-{}-{sequence}.html", std::process::id()));
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
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

fn with<R>(browser_id: &str, f: impl FnOnce(&Webview<Wry>) -> Result<R, String>) -> Result<R, String> {
    let guard = BROWSERS.lock().map_err(|e| e.to_string())?;
    f(guard.get(browser_id).ok_or("browser not open")?)
}

fn place(webview: &Webview<Wry>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(x, y))
        .and_then(|_| webview.set_size(LogicalSize::new(w, h)))
        .map_err(|e| e.to_string())
}

pub fn open(app: &AppHandle, browser_id: &str, url: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    {
        let guard = BROWSERS.lock().map_err(|e| e.to_string())?;
        if let Some(webview) = guard.get(browser_id) {
            webview.navigate(target).map_err(|e| e.to_string())?;
            webview.hide().map_err(|e| e.to_string())?;
            return place(webview, x, y, w, h);
        }
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let app2 = app.clone();
    let navigation_id = browser_id.to_owned();
    let label = format!("dock-browser-{browser_id}");
    let builder = WebviewBuilder::new(label, WebviewUrl::External(target)).devtools(false).on_navigation(
        move |next| {
            let _ = app2.emit(
                "browser:navigated",
                serde_json::json!({ "browserId": navigation_id.clone(), "url": next.as_str() }),
            );
            true
        },
    );
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
    with(browser_id, |webview| webview.navigate(target.clone()).map_err(|e| e.to_string()))
}

#[cfg(target_os = "windows")]
// Tauri rejects top-level data URLs by default; load generated previews into
// the existing child WebView2 instead of navigating to a data URL.
pub fn preview(browser_id: &str, html: String) -> Result<(), String> {
    with(browser_id, |webview| {
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
        receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| e.to_string())?
    })
}

#[cfg(not(target_os = "windows"))]
pub fn preview(_browser_id: &str, _html: String) -> Result<(), String> {
    Err("code preview requires WebView2".into())
}

pub fn bounds(browser_id: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with(browser_id, |webview| place(webview, x, y, w, h))
}

pub fn set_visible(browser_id: &str, visible: bool) -> Result<(), String> {
    with(browser_id, |webview| {
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
    with(browser_id, |webview| webview.eval(script).map_err(|e| e.to_string()))
}

pub fn close(browser_id: &str) -> Result<(), String> {
    let webview = BROWSERS.lock().map_err(|e| e.to_string())?.remove(browser_id);
    if let Some(webview) = webview {
        // Use the same complete shutdown sequence as browser_visible(false).
        // Hiding alone can leave the child HWND's old hit rectangle alive
        // until the asynchronous dispatcher finishes removing the webview.
        let _ = webview.set_size(LogicalSize::new(0.0, 0.0));
        let _ = webview.set_position(LogicalPosition::new(-32000.0, -32000.0));
        let _ = webview.hide();
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
