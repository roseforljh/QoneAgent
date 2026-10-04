use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow, Window, WindowEvent};

const STATE_FILE: &str = "window-state.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WindowState {
    width: u32,
    height: u32,
    x: i32,
    y: i32,
    maximized: bool,
}

static LAST_NORMAL_STATE: OnceLock<Mutex<Option<WindowState>>> = OnceLock::new();

fn last_normal_state() -> &'static Mutex<Option<WindowState>> {
    LAST_NORMAL_STATE.get_or_init(|| Mutex::new(None))
}

fn state_path<R: Runtime>(_app: &AppHandle<R>) -> Result<PathBuf, String> {
    let directory = crate::data_paths::runtime()?;
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let file = directory.join(STATE_FILE);
    Ok(file)
}

fn intersects_monitor<R: Runtime>(window: &tauri::WebviewWindow<R>, state: &WindowState) -> bool {
    let Ok(monitors) = window.available_monitors() else { return true; };
    monitors.into_iter().any(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        let right = position.x + size.width as i32;
        let bottom = position.y + size.height as i32;
        state.x < right
            && state.x + state.width as i32 > position.x
            && state.y < bottom
            && state.y + state.height as i32 > position.y
    })
}

pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return; };
    let Ok(path) = state_path(app) else { return; };
    let Ok(content) = std::fs::read_to_string(path) else { return; };
    let Ok(state) = serde_json::from_str::<WindowState>(&content) else { return; };
    if state.width == 0 || state.height == 0 || !intersects_monitor(&window, &state) { return; }

    if let Ok(mut saved) = last_normal_state().lock() {
        *saved = Some(WindowState { maximized: false, ..state.clone() });
    }

    let _ = window.set_size(PhysicalSize { width: state.width, height: state.height });
    let _ = window.set_position(PhysicalPosition { x: state.x, y: state.y });
    if state.maximized {
        let _ = window.maximize();
    }
}

pub fn observe<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_))
        || window.is_maximized().unwrap_or(false)
        || window.is_minimized().unwrap_or(false)
    {
        return;
    }
    let Ok(size) = window.inner_size() else { return; };
    let Ok(position) = window.outer_position() else { return; };
    let mut state = WindowState { width: size.width, height: size.height, x: position.x, y: position.y, maximized: false };
    match event {
        WindowEvent::Moved(position) => { state.x = position.x; state.y = position.y; }
        WindowEvent::Resized(size) => { state.width = size.width; state.height = size.height; }
        _ => return,
    }
    if let Ok(mut saved) = last_normal_state().lock() { *saved = Some(state); }
}

pub fn save<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return; };
    let maximized = window.is_maximized().unwrap_or(false);
    let state = if maximized {
        last_normal_state().lock().ok().and_then(|saved| saved.clone())
            .or_else(|| current_state(&window))
    } else {
        current_state(&window)
    };
    let Some(mut state) = state else { return; };
    state.maximized = maximized;
    let Ok(path) = state_path(app) else { return; };
    if let Ok(content) = serde_json::to_vec_pretty(&state) {
        if let Err(error) = std::fs::write(path, content) {
            eprintln!("[qone:window-state] failed to save: {error}");
        }
    }
}

fn current_state<R: Runtime>(window: &WebviewWindow<R>) -> Option<WindowState> {
    let size = window.inner_size().ok()?;
    let position = window.outer_position().ok()?;
    Some(WindowState { width: size.width, height: size.height, x: position.x, y: position.y, maximized: false })
}
