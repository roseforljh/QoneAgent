// Embedded browser: a single child Webview ("dock-browser") attached to the
// main window, positioned over the dock panel area by the frontend.
// Navigations are reported back via "browser:navigated" events.

use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewBuilder, WebviewUrl, Wry};

static BROWSER: LazyLock<Mutex<Option<Webview<Wry>>>> = LazyLock::new(|| Mutex::new(None));

fn with<R>(f: impl FnOnce(&Webview<Wry>) -> Result<R, String>) -> Result<R, String> {
    let guard = BROWSER.lock().map_err(|e| e.to_string())?;
    f(guard.as_ref().ok_or("browser not open")?)
}

fn place(webview: &Webview<Wry>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(x, y))
        .and_then(|_| webview.set_size(LogicalSize::new(w, h)))
        .map_err(|e| e.to_string())
}

pub fn open(app: &AppHandle, url: &str, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    {
        let guard = BROWSER.lock().map_err(|e| e.to_string())?;
        if let Some(webview) = guard.as_ref() {
            webview.navigate(target).map_err(|e| e.to_string())?;
            webview.hide().map_err(|e| e.to_string())?;
            return place(webview, x, y, w, h);
        }
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let app2 = app.clone();
    let builder = WebviewBuilder::new("dock-browser", WebviewUrl::External(target))
        .on_navigation(move |next| {
            let _ = app2.emit("browser:navigated", serde_json::json!({ "url": next.as_str() }));
            true
        });
    let webview = window
        // Do not expose a hit-test surface until the frontend owner has checked
        // whether a menu is open or this mount was disposed during creation.
        .add_child(
            builder,
            LogicalPosition::new(-32000.0, -32000.0),
            LogicalSize::new(1.0, 1.0),
        )
        .map_err(|e| e.to_string())?;
    *BROWSER.lock().map_err(|e| e.to_string())? = Some(webview.clone());
    webview.hide().map_err(|e| e.to_string())?;
    place(&webview, x, y, w, h)?;
    Ok(())
}

pub fn navigate(url: &str) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| e.to_string())?;
    with(|webview| webview.navigate(target.clone()).map_err(|e| e.to_string()))
}

pub fn bounds(x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    with(|webview| place(webview, x, y, w, h))
}

pub fn set_visible(visible: bool) -> Result<(), String> {
    with(|webview| {
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

pub fn eval(script: &str) -> Result<(), String> {
    with(|webview| webview.eval(script).map_err(|e| e.to_string()))
}

pub fn close() -> Result<(), String> {
    let webview = BROWSER.lock().map_err(|e| e.to_string())?.take();
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
