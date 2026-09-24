#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Mutex;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(all(windows, debug_assertions))]
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};

#[cfg(all(windows, debug_assertions))]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
    TH32CS_SNAPPROCESS,
};

#[cfg(all(windows, debug_assertions))]
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
};

#[cfg(windows)]
mod conpty;

#[cfg(all(windows, debug_assertions))]
mod dev_network;

struct SidecarState {
    stdin: Option<ChildStdin>,
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

pub struct Sidecar {
    state: Mutex<SidecarState>,
    generation: Arc<AtomicU64>,
}

#[cfg(all(windows, debug_assertions))]
fn dev_parent_process_id() -> Option<u32> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()? };
    let current_id = unsafe { GetCurrentProcessId() };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut parent_id = None;
    let first = unsafe { Process32FirstW(snapshot, &mut entry) };
    if first.is_ok() {
        loop {
            if entry.th32ProcessID == current_id {
                parent_id = Some(entry.th32ParentProcessID);
                break;
            }
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    unsafe { CloseHandle(snapshot).ok(); }
    parent_id
}

#[cfg(all(windows, debug_assertions))]
fn watch_dev_parent(app: AppHandle) {
    let Some(parent_id) = dev_parent_process_id() else { return; };
    if parent_id == 0 || parent_id == unsafe { GetCurrentProcessId() } { return; }
    std::thread::spawn(move || {
        // Keep the original process handle: opening a PID repeatedly can find
        // an exited process (or a different process after PID reuse).
        unsafe {
            if let Ok(handle) = OpenProcess(PROCESS_SYNCHRONIZE, false, parent_id) {
                if WaitForSingleObject(handle, u32::MAX) == WAIT_OBJECT_0 {
                    app.exit(0);
                }
                CloseHandle(handle).ok();
            } else {
                app.exit(0);
            }
        }
    });
}

impl Sidecar {
    fn send(&self, line: &str) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        let stdin = guard.stdin.as_mut().ok_or("sidecar not running")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| e.to_string())
    }

    fn respawn(&self, app: &AppHandle) -> Result<(), String> {
        let mut guard = self.state.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard._child.take() {
            let _ = child.kill();
        }
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *guard = spawn_sidecar(app, self.generation.clone(), generation)?;
        Ok(())
    }
}

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
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")));
    let manifest_binaries = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let browser_node = [
        resource_dir.join("qone-browser-node.exe"),
        resource_dir.join("qone-browser-node-x86_64-pc-windows-msvc.exe"),
        resource_dir.join("binaries/qone-browser-node.exe"),
        resource_dir.join("binaries/qone-browser-node-x86_64-pc-windows-msvc.exe"),
        manifest_binaries.join("qone-browser-node-x86_64-pc-windows-msvc.exe"),
    ]
    .into_iter()
    .find(|candidate| candidate.exists());
    let browser_helper = [
        resource_dir.join("binaries/qone-browser-helper.mjs"),
        resource_dir.join("qone-browser-helper.mjs"),
        manifest_binaries.join("qone-browser-helper.mjs"),
    ]
    .into_iter()
    .find(|candidate| candidate.exists());
    if let Some(node) = browser_node {
        command.env("QONE_BROWSER_NODE", node);
    }
    if let Some(helper) = browser_helper {
        command.env("QONE_BROWSER_HELPER", helper);
    }

    // The runtime is a console executable, but it is an internal sidecar of
    // the desktop app. Keep its stdout/stderr piped without opening a second
    // Windows console when Qone is launched by double-clicking the exe.
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = command
        .current_dir(&runtime_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn agent runtime: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout on sidecar")?;
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    let emitted = persist_runtime_secret(&l).unwrap_or(l);
                    let _ = app_handle.emit("runtime-event", &emitted);
                    if emitted.contains("\"type\":\"agent.completed\"") {
                        let _ = app_handle
                            .notification()
                            .builder()
                            .title("QoneAgent")
                            .body("Agent run completed")
                            .show();
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        if generation.load(Ordering::SeqCst) == generation_id {
            let _ = app_handle.emit("runtime-event", "{\"type\":\"runtime.exited\"}");
        }
    });

    Ok(SidecarState {
        stdin: child.stdin.take(),
        _child: Some(child),
    })
}

#[tauri::command]
fn runtime_send(cmd: String, state: State<Sidecar>) -> Result<(), String> {
    state.send(&cmd)
}

#[tauri::command]
fn runtime_restart(app: AppHandle, state: State<Sidecar>) -> Result<(), String> {
    state.respawn(&app)
}

#[tauri::command]
fn pick_workspace() -> Option<String> {
    rfd::FileDialog::new()
        .set_title("Select Workspace")
        .pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct DroppedFilePayload {
    name: String,
    data: String,
}

#[tauri::command]
fn read_dropped_file(path: String) -> Result<DroppedFilePayload, String> {
    const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
    let file_path = std::path::PathBuf::from(&path);
    let metadata = std::fs::metadata(&file_path).map_err(|error| format!("无法读取附件：{error}"))?;
    if !metadata.is_file() {
        return Err("拖入的项目不是文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("附件过大，单个文件不能超过 8 MB".into());
    }
    let name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("attachment")
        .to_owned();
    let data = std::fs::read(&file_path)
        .map_err(|error| format!("无法读取附件：{error}"))?;
    Ok(DroppedFilePayload { name, data: BASE64.encode(data) })
}

// --- Windows Credential Manager ---

#[cfg(windows)]
mod creds {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
        CRED_TYPE_GENERIC,
    };

    const PREFIX: &str = "QoneAgent:";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        let target = wide(&format!("{PREFIX}{key}"));
        let mut blob = value.encode_utf16().collect::<Vec<u16>>();
        let blob_bytes =
            unsafe { std::slice::from_raw_parts(blob.as_mut_ptr() as *const u8, blob.len() * 2) };
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: windows::core::PWSTR(target.as_ptr() as *mut _),
            CredentialBlobSize: (blob_bytes.len()) as u32,
            CredentialBlob: blob_bytes.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&cred, 0).map_err(|e| format!("CredWrite failed: {e}")) }
    }

    pub fn get(key: &str) -> Result<Option<String>, String> {
        let target = wide(&format!("{PREFIX}{key}"));
        let mut cred_ptr: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe {
            match CredReadW(
                PCWSTR(target.as_ptr()),
                CRED_TYPE_GENERIC,
                None,
                &mut cred_ptr,
            ) {
                Ok(()) => {
                    let cred = &*cred_ptr;
                    let blob = std::slice::from_raw_parts(
                        cred.CredentialBlob,
                        cred.CredentialBlobSize as usize,
                    );
                    let utf16: &[u16] =
                        std::slice::from_raw_parts(blob.as_ptr() as *const u16, blob.len() / 2);
                    let value = String::from_utf16_lossy(utf16)
                        .trim_end_matches('\0')
                        .to_string();
                    CredFree(cred_ptr as *const _);
                    Ok(Some(value))
                }
                Err(e) => {
                    // ERROR_NOT_FOUND = 1168
                    if e.code().0 as u32 == 0x80070490 || e.code().0 as u32 == 1168 {
                        Ok(None)
                    } else {
                        Err(format!("CredRead failed: {e}"))
                    }
                }
            }
        }
    }

    pub fn delete(key: &str) -> Result<(), String> {
        let target = wide(&format!("{PREFIX}{key}"));
        unsafe {
            CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None)
                .map_err(|e| format!("CredDelete failed: {e}"))
        }
    }
}

fn persist_runtime_secret(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "mcp.oauth.token" {
        return None;
    }
    let key = value.get("key")?.as_str()?;
    let server_id = value.get("serverId")?.as_str()?;
    let token = value.get("accessToken")?.as_str()?;
    let result = validate_secret_key(key).and_then(|_| {
        #[cfg(windows)]
        return creds::set(key, token);
        #[allow(unreachable_code)]
        Err("secrets only supported on Windows".into())
    });
    Some(match result {
        Ok(()) => {
            serde_json::json!({ "type": "mcp.oauth.saved", "serverId": server_id, "key": key })
                .to_string()
        }
        Err(error) => serde_json::json!({ "type": "error", "message": error }).to_string(),
    })
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
    if value.encode_utf16().count() * 2 > 2560 {
        return Err("secret value is too large".into());
    }
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

// --- PTY commands ---

#[tauri::command]
fn terminal_spawn(
    app: AppHandle,
    terminal_id: String,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<i16>,
    rows: Option<i16>,
) -> Result<(), String> {
    #[cfg(windows)]
    return conpty::spawn(
        &terminal_id,
        shell.as_deref().unwrap_or("powershell.exe"),
        cwd.as_deref(),
        cols.unwrap_or(120),
        rows.unwrap_or(30),
        &app,
    );
    #[allow(unreachable_code)]
    Err("pty only supported on Windows".into())
}

#[tauri::command]
fn terminal_write(terminal_id: String, data: String) -> Result<(), String> {
    #[cfg(windows)]
    return conpty::write(&terminal_id, &data);
    #[allow(unreachable_code)]
    Err("pty only supported on Windows".into())
}

#[tauri::command]
fn terminal_resize(terminal_id: String, cols: i16, rows: i16) -> Result<(), String> {
    #[cfg(windows)]
    return conpty::resize(&terminal_id, cols, rows);
    #[allow(unreachable_code)]
    Err("pty only supported on Windows".into())
}

#[tauri::command]
fn terminal_kill(terminal_id: String) -> Result<(), String> {
    #[cfg(windows)]
    return conpty::kill(&terminal_id);
    #[allow(unreachable_code)]
    Ok(())
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
    tauri::Builder::default()
        .on_page_load(|_webview, payload| {
            #[cfg(debug_assertions)]
            eprintln!("[qone:page] {:?} {}", payload.event(), payload.url());
        })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            #[cfg(all(windows, debug_assertions))]
            dev_network::install(app.handle());
            let generation = Arc::new(AtomicU64::new(0));
            let state = spawn_sidecar(app.handle(), generation.clone(), 0)?;
            app.manage(Sidecar {
                state: Mutex::new(state),
                generation,
            });

            #[cfg(all(windows, debug_assertions))]
            watch_dev_parent(app.handle().clone());

            let show = MenuItem::with_id(app, "show", "Show Qone", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
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
                    "quit" => app.exit(0),
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
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(debug_assertions)]
                {
                    // Let `tauri dev` exit normally so the debug executable is
                    // released before the next Cargo rebuild.
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
            pick_workspace,
            read_dropped_file,
            secret_set,
            secret_get,
            secret_delete,
            terminal_spawn,
            terminal_write,
            terminal_resize,
            terminal_kill
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            #[cfg(windows)]
            if let tauri::RunEvent::Exit = event {
                conpty::kill_all();
            }
            #[cfg(not(windows))]
            let _ = event;
        });
}
