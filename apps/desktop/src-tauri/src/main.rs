#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
mod native_error;
use native_error::NativeError;
mod auth_files;
mod credential_bridge;
mod data_paths;
mod native_copy;
mod runtime_transport;
mod webview_policy;
mod window_state;
use credential_bridge::persist_runtime_secret;
use native_copy::{set_native_copy, NativeCopy, NativeCopyState};
use runtime_transport::{runtime_subscribe, RuntimeBatch, RuntimeTransport};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
mod conpty;

#[cfg(desktop)]
mod browser;

#[cfg(all(windows, debug_assertions))]
mod dev_network;

struct SidecarState {
    stdin: Option<Arc<Mutex<ChildStdin>>>,
    _child: Option<Child>,
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        if let Some(mut child) = self._child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[derive(Clone)]
pub struct Sidecar {
    state: Arc<Mutex<SidecarState>>,
    generation: Arc<AtomicU64>,
    send_order: Arc<tauri::async_runtime::Mutex<()>>,
}

impl Sidecar {
    fn send(&self, line: &str, generation: u64) -> Result<(), String> {
        let input = {
            let guard = self.state.lock().map_err(|e| e.to_string())?;
            if self.generation.load(Ordering::SeqCst) != generation {
                return Err("sidecar restarted before command delivery".into());
            }
            guard.stdin.as_ref().ok_or("sidecar not running")?.clone()
        };
        // Pipe writes can block. The lifecycle lock must stay available so a
        // restart can kill the child and release a stalled writer.
        let mut stdin = input.lock().map_err(|e| e.to_string())?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    async fn send_ordered(&self, line: String) -> Result<(), String> {
        let generation = self.generation.load(Ordering::SeqCst);
        let _order = self.send_order.lock().await;
        let worker = self.clone();
        tauri::async_runtime::spawn_blocking(move || worker.send(&line, generation))
            .await
            .map_err(|error| error.to_string())?
    }

    fn respawn(&self, app: &AppHandle) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        guard.stdin.take();
        if let Some(mut child) = guard._child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *guard = spawn_sidecar(app, self.generation.clone(), generation)?;
        Ok(())
    }
}

#[cfg(test)]
mod sidecar_tests;

fn spawn_sidecar(
    app: &AppHandle,
    generation: Arc<AtomicU64>,
    generation_id: u64,
) -> Result<SidecarState, String> {
    // Resolve the workspace runtime from the Tauri manifest in development.
    // The old relative path was evaluated from src-tauri and pointed at a
    // non-existent apps/desktop/agent-runtime directory.
    let runtime_path = std::env::var_os("QONE_AGENT_RUNTIME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            #[cfg(debug_assertions)]
            {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("apps")
                    .join("agent-runtime")
                    .join("src")
                    .join("index.ts")
            }
            #[cfg(not(debug_assertions))]
            {
                let resource_dir = app
                    .path()
                    .resource_dir()
                    .unwrap_or_else(|_| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
                [
                    resource_dir.join("qone-runtime.exe"),
                    resource_dir.join("qone-runtime-x86_64-pc-windows-msvc.exe"),
                    resource_dir.join("binaries/qone-runtime.exe"),
                    resource_dir.join("binaries/qone-runtime-x86_64-pc-windows-msvc.exe"),
                ]
                .into_iter()
                .find(|candidate| candidate.exists())
                .unwrap_or_else(|| resource_dir.join("qone-runtime.exe"))
            }
            /*
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("apps")
                    .join("agent-runtime")
                    .join("src")
                    .join("index.ts")
            */
        });
    let runtime_entry = runtime_path.canonicalize().map_err(|e| {
        format!(
            "agent runtime entry not found ({}): {e}",
            runtime_path.display()
        )
    })?;
    let is_executable = runtime_entry.extension().and_then(|e| e.to_str()) == Some("exe");
    let runtime_dir = if is_executable {
        runtime_entry.parent()
    } else {
        runtime_entry.parent().and_then(|p| p.parent())
    }
    .ok_or("invalid agent runtime path")?;

    let mut command = if is_executable {
        let command = Command::new(&runtime_entry);
        command
    } else {
        let mut command = Command::new("bun");
        command.arg("run").arg(&runtime_entry);
        command
    };
    // The runtime is a console executable, but it is an internal sidecar of
    // the desktop app. Keep its stdout/stderr piped without opening a second
    // Windows console when Qone is launched by double-clicking the exe.
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command
        .current_dir(&runtime_dir)
        .env("QONE_DATA_DIR", data_paths::root()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn agent runtime: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout on sidecar")?;
    let app_handle = app.clone();
    let transport = app.state::<RuntimeTransport>().inner().clone();
    std::thread::spawn(move || {
        let (lines_tx, lines_rx) = std::sync::mpsc::sync_channel::<String>(256);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else {
                    break;
                };
                if lines_tx.send(line).is_err() {
                    break;
                }
            }
        });
        let mut batch = RuntimeBatch::new(16, Duration::from_millis(8));
        let flush = |batch: &mut RuntimeBatch| {
            let payload = batch.drain();
            if payload.is_empty() {
                return;
            }
            transport.send(&app_handle, payload);
        };
        loop {
            if generation.load(Ordering::SeqCst) != generation_id {
                break;
            }
            let timeout = batch.timeout(std::time::Instant::now());
            match lines_rx.recv_timeout(timeout) {
                Ok(line) if !line.trim().is_empty() => {
                    let event_type = runtime_event_type(&line);
                    if event_type.as_deref() == Some("agent.event")
                        && is_completed_agent_event(&line)
                    {
                        let _ = app_handle
                            .notification()
                            .builder()
                            .title("QoneAgent")
                            .body(
                                app_handle
                                    .state::<NativeCopyState>()
                                    .copy
                                    .lock()
                                    .map(|copy| copy.completed.clone())
                                    .unwrap_or_else(|_| "Agent run completed".into()),
                            )
                            .show();
                    }
                    let emitted = match event_type.as_deref() {
                        Some("mcp.oauth.token")
                        | Some("mcp.oauth.credential")
                        | Some("mcp.oauth.invalidated") => persist_runtime_secret(&line),
                        _ => line,
                    };
                    if let Ok(raw) = serde_json::value::RawValue::from_string(emitted) {
                        if batch.push(raw, std::time::Instant::now()) {
                            flush(&mut batch);
                        }
                    }
                }
                Ok(_) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => flush(&mut batch),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    flush(&mut batch);
                    break;
                }
            }
        }
        if generation.load(Ordering::SeqCst) == generation_id {
            if let Ok(raw) = serde_json::value::RawValue::from_string(
                "{\"type\":\"runtime.exited\"}".to_string(),
            ) {
                transport.send(&app_handle, vec![raw]);
            }
        }
    });

    Ok(SidecarState {
        stdin: child.stdin.take().map(|input| Arc::new(Mutex::new(input))),
        _child: Some(child),
    })
}

#[tauri::command]
async fn runtime_send(cmd: String, state: State<'_, Sidecar>) -> Result<(), String> {
    let sidecar = state.inner().clone();
    sidecar.send_ordered(cmd).await
}

#[tauri::command]
async fn runtime_restart(app: AppHandle, state: State<'_, Sidecar>) -> Result<(), String> {
    let sidecar = state.inner().clone();
    let worker = sidecar.clone();
    tauri::async_runtime::spawn_blocking(move || worker.respawn(&app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn pick_workspace(title: String) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(title)
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

fn attachment_path_info(path: &std::path::Path) -> Result<AttachmentFileInfo, NativeError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| NativeError::detail("native.attachmentRead", error))?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(NativeError::new("native.attachmentType"));
    }
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("attachment")
        .to_owned();
    Ok(AttachmentFileInfo {
        name,
        path: path.to_string_lossy().into_owned(),
        size: if metadata.is_file() {
            metadata.len()
        } else {
            0
        },
        is_directory: metadata.is_dir(),
    })
}

#[tauri::command]
fn inspect_dropped_file(path: String) -> Result<AttachmentFileInfo, NativeError> {
    attachment_path_info(std::path::Path::new(&path))
}

#[derive(serde::Serialize)]
struct AttachmentFileInfo {
    name: String,
    path: String,
    size: u64,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
}

#[tauri::command]
fn pick_attachment_files(title: String) -> Result<Vec<AttachmentFileInfo>, NativeError> {
    let Some(paths) = rfd::FileDialog::new().set_title(title).pick_files() else {
        return Ok(Vec::new());
    };
    paths
        .into_iter()
        .map(|path| attachment_path_info(&path))
        .collect()
}

#[tauri::command]
fn pick_attachment_folder(title: String) -> Result<Option<AttachmentFileInfo>, NativeError> {
    rfd::FileDialog::new()
        .set_title(title)
        .pick_folder()
        .map(|path| attachment_path_info(&path))
        .transpose()
}

#[tauri::command]
fn authorize_attachment_preview(app: AppHandle, path: String) -> Result<(), NativeError> {
    let file = std::path::Path::new(&path);
    let extension = file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !file.is_absolute()
        || !["png", "jpg", "jpeg", "webp", "gif"]
            .iter()
            .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return Err(NativeError::new("native.previewPath"));
    }
    if attachment_path_info(file)?.is_directory {
        return Err(NativeError::new("native.previewFolder"));
    }
    app.asset_protocol_scope()
        .allow_file(file)
        .map_err(|error| NativeError::detail("native.previewFailed", error))
}

#[tauri::command]
fn authorize_file_preview(
    app: AppHandle,
    path: String,
    allowed_root: String,
) -> Result<String, NativeError> {
    let file = std::path::Path::new(&path);
    if !file.is_absolute() {
        return Err(NativeError::new("native.filePreviewPath"));
    }
    let canonical = file
        .canonicalize()
        .map_err(|error| NativeError::detail("native.filePreviewFailed", error))?;
    if !canonical.is_file() {
        return Err(NativeError::new("native.filePreviewType"));
    }
    let root = std::path::Path::new(&allowed_root)
        .canonicalize()
        .map_err(|error| NativeError::detail("native.filePreviewFailed", error))?;
    if !canonical.starts_with(&root) {
        return Err(NativeError::new("native.filePreviewScope"));
    }
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| NativeError::detail("native.filePreviewFailed", error))?;
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
async fn save_image_as(filename: String, data: String, title: String) -> Result<bool, NativeError> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = std::path::Path::new(&filename)
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("image.png");
        let Some(path) = rfd::FileDialog::new()
            .set_title(title)
            .set_file_name(name)
            .save_file()
        else {
            return Ok(false);
        };
        let bytes = BASE64
            .decode(data)
            .map_err(|error| NativeError::detail("native.imageDecode", error))?;
        if bytes.is_empty() {
            return Err(NativeError::new("native.imageEmpty"));
        }
        std::fs::write(path, bytes)
            .map_err(|error| NativeError::detail("native.imageSave", error))?;
        Ok(true)
    })
    .await
    .map_err(|error| NativeError::detail("native.imageSave", error))?
}

// --- Windows Credential Manager ---

#[cfg(windows)]
mod creds;

#[derive(serde::Deserialize)]
struct RuntimeEventType<'a> {
    #[serde(borrow)]
    r#type: std::borrow::Cow<'a, str>,
}

#[derive(serde::Deserialize)]
struct RuntimeAgentEventType<'a> {
    #[serde(borrow)]
    r#type: Option<&'a str>,
}

#[derive(serde::Deserialize)]
struct RuntimeAgentEnvelope<'a> {
    #[serde(borrow)]
    r#type: Option<&'a str>,
    event: Option<RuntimeAgentEventType<'a>>,
}

fn runtime_event_type(line: &str) -> Option<std::borrow::Cow<'_, str>> {
    Some(
        serde_json::from_str::<RuntimeEventType<'_>>(line)
            .ok()?
            .r#type,
    )
}

fn is_completed_agent_event(line: &str) -> bool {
    let Ok(envelope) = serde_json::from_str::<RuntimeAgentEnvelope<'_>>(line) else {
        return false;
    };
    envelope.r#type == Some("agent.event")
        && envelope.event.and_then(|event| event.r#type) == Some("agent.completed")
}

fn validate_secret_key(key: &str) -> Result<(), String> {
    let Some((namespace, name)) = key.split_once(':') else {
        return Err("invalid secret key".into());
    };
    let valid_namespace = !namespace.is_empty()
        && namespace.len() <= 64
        && namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-');
    let valid_name = !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'));
    if valid_namespace && valid_name {
        Ok(())
    } else {
        Err("invalid secret key".into())
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    validate_secret_key(&key)?;
    #[cfg(windows)]
    return creds::set(&key, &value);
    #[allow(unreachable_code)]
    Err("secrets only supported on Windows".into())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    validate_secret_key(&key)?;
    #[cfg(windows)]
    return creds::get(&key);
    #[allow(unreachable_code)]
    Err("secrets only supported on Windows".into())
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    validate_secret_key(&key)?;
    #[cfg(windows)]
    return creds::delete(&key);
    #[allow(unreachable_code)]
    Err("secrets only supported on Windows".into())
}

#[tauri::command]
fn auth_file_save(
    app_id: String,
    cookies: Vec<auth_files::AuthCookie>,
) -> Result<auth_files::AuthFile, String> {
    auth_files::save(app_id, cookies)
}

#[tauri::command]
fn auth_file_get(app_id: String) -> Result<Option<auth_files::AuthFile>, String> {
    auth_files::get(app_id)
}

#[tauri::command]
fn auth_file_delete(app_id: String) -> Result<(), String> {
    auth_files::delete(app_id)
}

// --- PTY commands ---

#[tauri::command]
async fn terminal_spawn(
    app: AppHandle,
    terminal_id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<i16>,
    rows: Option<i16>,
) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        conpty::spawn(
            &terminal_id,
            shell.as_deref().unwrap_or("powershell.exe"),
            cwd.as_deref(),
            cols.unwrap_or(120),
            rows.unwrap_or(30),
            &app,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("pty only supported on Windows".into())
}

#[tauri::command]
async fn terminal_write(terminal_id: String, data: String) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || conpty::write(&terminal_id, &data))
        .await
        .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("pty only supported on Windows".into())
}

#[tauri::command]
async fn terminal_resize(terminal_id: String, cols: i16, rows: i16) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || conpty::resize(&terminal_id, cols, rows))
        .await
        .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("pty only supported on Windows".into())
}

#[tauri::command]
async fn terminal_kill(terminal_id: String) -> Result<(), String> {
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || conpty::kill(&terminal_id))
        .await
        .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Ok(())
}

// --- embedded browser commands ---

#[tauri::command]
async fn browser_open(
    app: AppHandle,
    browser_id: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    initialization_script: Option<String>,
) -> Result<(), String> {
    #[cfg(desktop)]
    // WebView2 creation must not run in the synchronous IPC/main-thread handler.
    return tauri::async_runtime::spawn_blocking(move || {
        browser::open(
            &app,
            &browser_id,
            &url,
            x,
            y,
            w,
            h,
            initialization_script.as_deref(),
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_navigate(browser_id: String, url: String) -> Result<(), String> {
    #[cfg(desktop)]
    return browser::navigate(&browser_id, &url);
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_preview(browser_id: String, html: String) -> Result<(), String> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || browser::preview(&browser_id, html))
        .await
        .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_open_preview_external(app: AppHandle, html: String) -> Result<(), String> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || {
        browser::open_preview_external(&app, &html)
    })
    .await
    .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_bounds(browser_id: String, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    #[cfg(desktop)]
    return browser::bounds(&browser_id, x, y, w, h);
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_visible(browser_id: String, visible: bool) -> Result<(), String> {
    #[cfg(desktop)]
    return browser::set_visible(&browser_id, visible);
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_eval(browser_id: String, script: String) -> Result<(), String> {
    #[cfg(desktop)]
    return browser::eval(&browser_id, &script);
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_eval_result(browser_id: String, script: String) -> Result<String, String> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || {
        browser::eval_result(&browser_id, &script)
    })
    .await
    .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_get_cookies(
    browser_id: String,
    url: String,
) -> Result<Vec<auth_files::AuthCookie>, String> {
    #[cfg(desktop)]
    return tauri::async_runtime::spawn_blocking(move || browser::cookies(&browser_id, &url))
        .await
        .map_err(|error| error.to_string())?;
    #[allow(unreachable_code)]
    Err("browser only supported on desktop".into())
}

#[tauri::command]
async fn browser_close(app: AppHandle, browser_id: String) -> Result<(), String> {
    #[cfg(desktop)]
    return browser::close(&app, &browser_id);
    #[allow(unreachable_code)]
    Ok(())
}

#[tauri::command]
fn opencli_cdp_endpoint() -> String {
    if let Ok(endpoint) = std::env::var("QONE_OPENCLI_CDP_ENDPOINT") {
        if !endpoint.trim().is_empty() {
            return endpoint;
        }
    }
    let port = std::env::var("QONE_WEBVIEW_CDP_PORT").unwrap_or_else(|_| "9223".into());
    format!("http://127.0.0.1:{port}")
}

#[tauri::command]
fn frontend_diagnostic(message: String) {
    #[cfg(all(windows, debug_assertions))]
    dev_network::log(&format!("frontend: {message}"));
    #[cfg(all(not(windows), debug_assertions))]
    eprintln!("[qone:frontend] {message}");
    #[cfg(not(debug_assertions))]
    let _ = message;
}

fn main() {
    #[cfg(windows)]
    {
        let port = std::env::var("QONE_WEBVIEW_CDP_PORT").unwrap_or_else(|_| "9223".into());
        let extra = format!("--remote-debugging-port={port} --remote-allow-origins=*");
        let current = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        if !current.contains("--remote-debugging-port=") {
            let merged = if current.trim().is_empty() {
                extra
            } else {
                format!("{current} {extra}")
            };
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);
        }
    }
    tauri::Builder::default()
        .plugin(webview_policy::init())
        .on_page_load(|_webview, payload| {
            #[cfg(debug_assertions)]
            eprintln!("[qone:page] {:?} {}", payload.event(), payload.url());
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            data_paths::ensure_global_instructions().map_err(std::io::Error::other)?;
            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .ok_or("Missing main window configuration")?;
            tauri::WebviewWindowBuilder::from_config(app, config)?
                .data_directory(data_paths::webview().map_err(std::io::Error::other)?)
                .build()?;
            #[cfg(all(windows, debug_assertions))]
            dev_network::install(app.handle());
            let show = MenuItem::with_id(app, "show", "Show Qone", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            app.manage(NativeCopyState {
                copy: Mutex::new(NativeCopy {
                    show: "Show Qone".into(),
                    quit: "Quit".into(),
                    completed: "Agent run completed".into(),
                }),
                show,
                quit,
            });
            let generation = Arc::new(AtomicU64::new(0));
            app.manage(RuntimeTransport::default());
            let state = spawn_sidecar(app.handle(), generation.clone(), 0)?;
            window_state::restore(app.handle());
            app.manage(Sidecar {
                state: Arc::new(Mutex::new(state)),
                generation,
                send_order: Arc::new(tauri::async_runtime::Mutex::new(())),
            });
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("missing application icon")?;
            TrayIconBuilder::with_id("qone-agent")
                .menu(&menu)
                .icon(icon)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        #[cfg(debug_assertions)]
                        eprintln!("[qone:lifecycle] tray quit requested");
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        if let Some(window) = tray.app_handle().get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            window_state::observe(window, event);
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                window_state::save(window.app_handle());
                #[cfg(debug_assertions)]
                {
                    // Let `tauri dev` exit normally so the debug executable is
                    // released before the next Cargo rebuild.
                    eprintln!(
                        "[qone:lifecycle] window close requested: {}",
                        window.label()
                    );
                    let _ = (window, api);
                }
                #[cfg(not(debug_assertions))]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            frontend_diagnostic,
            runtime_send,
            runtime_restart,
            runtime_subscribe,
            pick_workspace,
            inspect_dropped_file,
            pick_attachment_files,
            pick_attachment_folder,
            authorize_attachment_preview,
            authorize_file_preview,
            save_image_as,
            set_native_copy,
            secret_set,
            secret_get,
            secret_delete,
            auth_file_save,
            auth_file_get,
            auth_file_delete,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill,
            browser_open,
            browser_navigate,
            browser_preview,
            browser_open_preview_external,
            browser_bounds,
            browser_visible,
            browser_eval,
            browser_eval_result,
            browser_get_cookies,
            browser_close,
            opencli_cdp_endpoint,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                window_state::save(_app);
                #[cfg(debug_assertions)]
                eprintln!("[qone:lifecycle] application exited");
                #[cfg(windows)]
                conpty::kill_all();
                #[cfg(desktop)]
                browser::cleanup_external_previews();
            }
        });
}
