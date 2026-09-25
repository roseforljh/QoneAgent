// Windows ConPTY implementation. Owns pseudo-console lifecycle:
// spawn shell attached to a ConPTY, stream output via "terminal:data" events,
// accept writes / resize / kill.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
use windows::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::*;

struct Pty {
    hpc: HPCON,
    input: usize,   // HANDLE as usize — we write here
    process: usize, // HANDLE
}

unsafe impl Send for Pty {}
unsafe impl Sync for Pty {}

static PTYS: LazyLock<Mutex<HashMap<String, Pty>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn executable_on_path(executable: &str) -> bool {
    let executable = executable.trim_matches('"');
    if executable.is_empty() {
        return false;
    }

    let path = std::path::Path::new(executable);
    if path.is_absolute() || executable.contains('\\') || executable.contains('/') {
        return path.is_file();
    }

    let has_extension = path.extension().is_some();
    let candidates = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .flat_map(|directory| {
            let mut candidates = vec![directory.join(executable)];
            if !has_extension {
                candidates.push(directory.join(format!("{executable}.exe")));
            }
            candidates
        });

    candidates.into_iter().any(|candidate| candidate.is_file())
}

fn shell_command(shell: &str) -> String {
    let requested = shell.trim();
    let executable = requested
        .strip_prefix('"')
        .and_then(|value| value.split_once('"').map(|(name, _)| name))
        .unwrap_or_else(|| requested.split_whitespace().next().unwrap_or_default());

    if executable_on_path(executable) {
        return requested.to_owned();
    }

    // PowerShell 7 is optional on Windows. The inbox Windows PowerShell is
    // present on supported desktop installations and is sufficient for an
    // interactive terminal when pwsh.exe is unavailable.
    if executable.eq_ignore_ascii_case("pwsh") || executable.eq_ignore_ascii_case("pwsh.exe") {
        return "powershell.exe -NoLogo -NoProfile".to_owned();
    }

    requested.to_owned()
}

pub fn spawn(
    id: &str,
    shell: &str,
    cwd: Option<&str>,
    cols: i16,
    rows: i16,
    app: &AppHandle,
) -> Result<(), String> {
    let app = app.clone();
    spawn_with_events(
        id,
        shell,
        cwd,
        cols,
        rows,
        Arc::new(move |event, payload| {
            let _ = app.emit(event, payload);
        }),
    )
}

fn spawn_with_events(
    id: &str,
    shell: &str,
    cwd: Option<&str>,
    cols: i16,
    rows: i16,
    emit: Arc<dyn Fn(&str, serde_json::Value) + Send + Sync + 'static>,
) -> Result<(), String> {
    if PTYS.lock().map_err(|e| e.to_string())?.contains_key(id) {
        return Err(format!("terminal {id} already exists"));
    }

    unsafe {
        // Pipe 1: our write -> conpty input. Pipe 2: conpty output -> our read.
        let mut in_read = HANDLE::default();
        let mut in_write = HANDLE::default();
        CreatePipe(&mut in_read, &mut in_write, None, 0).map_err(|e| e.to_string())?;
        let mut out_read = HANDLE::default();
        let mut out_write = HANDLE::default();
        CreatePipe(&mut out_read, &mut out_write, None, 0).map_err(|e| e.to_string())?;

        let hpc = CreatePseudoConsole(COORD { X: cols, Y: rows }, in_read, out_write, 0)
            .map_err(|e| format!("CreatePseudoConsole: {e}"))?;
        // ConPTY owns these ends now.
        let _ = CloseHandle(in_read);
        let _ = CloseHandle(out_write);

        // Attribute list carrying PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE.
        let mut attr_size: usize = 0;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attr_size);
        let attr_buf = vec![0u8; attr_size];
        let attr_list = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_ptr() as *mut _);
        InitializeProcThreadAttributeList(Some(attr_list), 1, None, &mut attr_size)
            .map_err(|e| format!("InitAttrList: {e}"))?;
        UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(hpc.0 as *const _),
            std::mem::size_of::<HPCON>(),
            None,
            None,
        )
        .map_err(|e| format!("UpdateProcAttr: {e}"))?;

        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // Explicit INVALID handles let ConPTY supply console I/O. Omitting
        // these can inherit the parent's redirected stdout/stderr even with
        // bInheritHandles=false (e.g. when launched by the dev runner).
        // Null handles are different: they disable the child's standard I/O.
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        si.lpAttributeList = attr_list;

        let command = shell_command(shell);
        let mut cmd = to_wide(&command);
        let cwd_v = cwd.map(to_wide);
        let mut pi = PROCESS_INFORMATION::default();
        CreateProcessW(
            None,
            Some(PWSTR(cmd.as_mut_ptr())),
            None,
            None,
            false,
            EXTENDED_STARTUPINFO_PRESENT,
            None,
            cwd_v
                .as_ref()
                .map(|v| PCWSTR(v.as_ptr()))
                .unwrap_or_default(),
            &si.StartupInfo,
            &mut pi,
        )
        .map_err(|e| format!("CreateProcessW: {e}"))?;
        let _ = CloseHandle(pi.hThread);
        DeleteProcThreadAttributeList(attr_list);

        PTYS.lock().map_err(|e| e.to_string())?.insert(
            id.to_string(),
            Pty {
                hpc,
                input: in_write.0 as usize,
                process: pi.hProcess.0 as usize,
            },
        );

        // Reader thread: ConPTY output -> "terminal:data" events.
        let id_owned = id.to_string();
        let out_raw = out_read.0 as usize;
        let process_raw = pi.hProcess.0 as usize;
        let reader_emit = emit.clone();
        std::thread::spawn(move || {
            let h = HANDLE(out_raw as *mut _);
            let mut buf = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                let mut n = 0u32;
                if ReadFile(h, Some(&mut buf), Some(&mut n), None).is_err() || n == 0 {
                    break;
                }
                pending.extend_from_slice(&buf[..n as usize]);
                let data = decode_output(&mut pending, false);
                reader_emit(
                    "terminal:data",
                    serde_json::json!({ "terminalId": id_owned, "data": data }),
                );
            }
            if !pending.is_empty() {
                reader_emit(
                    "terminal:data",
                    serde_json::json!({ "terminalId": id_owned, "data": decode_output(&mut pending, true) }),
                );
            }
            let _ = CloseHandle(h);
        });

        // Wait independently of the output pipe. A natural shell exit does not
        // close ConPTY's pipe until ClosePseudoConsole is called; keep the reader
        // draining during that call to avoid a full-pipe deadlock.
        let id_owned = id.to_owned();
        let waiter_emit = emit.clone();
        std::thread::spawn(move || {
            let process = HANDLE(process_raw as *mut _);
            WaitForSingleObject(process, u32::MAX);
            let removed = PTYS.lock().ok().and_then(|mut terminals| {
                if terminals.get(&id_owned).map(|pty| pty.process) == Some(process_raw) {
                    terminals.remove(&id_owned)
                } else {
                    None
                }
            });
            if let Some(pty) = removed {
                let _ = CloseHandle(HANDLE(pty.input as *mut _));
                ClosePseudoConsole(pty.hpc);
                waiter_emit(
                    "terminal:exit",
                    serde_json::json!({ "terminalId": id_owned }),
                );
            }
            let _ = CloseHandle(process);
        });

        Ok(())
    }
}

// Pipe reads may split a Chinese character (or any UTF-8 sequence) in half.
fn decode_output(pending: &mut Vec<u8>, eof: bool) -> String {
    let mut output = String::new();
    let mut consumed = 0;
    while consumed < pending.len() {
        match std::str::from_utf8(&pending[consumed..]) {
            Ok(text) => {
                output.push_str(text);
                consumed = pending.len();
            }
            Err(error) => {
                let end = consumed + error.valid_up_to();
                output.push_str(std::str::from_utf8(&pending[consumed..end]).unwrap());
                consumed = end;
                if let Some(length) = error.error_len() {
                    output.push('\u{fffd}');
                    consumed += length;
                } else if eof {
                    output.push('\u{fffd}');
                    consumed = pending.len();
                } else {
                    break;
                }
            }
        }
    }
    pending.drain(..consumed);
    output
}

pub fn write(id: &str, data: &str) -> Result<(), String> {
    let guard = PTYS.lock().map_err(|e| e.to_string())?;
    let pty = guard.get(id).ok_or("no such terminal")?;
    unsafe {
        let h = HANDLE(pty.input as *mut _);
        let mut remaining = data.as_bytes();
        while !remaining.is_empty() {
            let mut written = 0u32;
            WriteFile(h, Some(remaining), Some(&mut written), None)
                .map_err(|e| format!("WriteFile: {e}"))?;
            if written == 0 {
                return Err("terminal input pipe closed".into());
            }
            remaining = &remaining[written as usize..];
        }
    }
    Ok(())
}

pub fn resize(id: &str, cols: i16, rows: i16) -> Result<(), String> {
    let guard = PTYS.lock().map_err(|e| e.to_string())?;
    let pty = guard.get(id).ok_or("no such terminal")?;
    unsafe { ResizePseudoConsole(pty.hpc, COORD { X: cols, Y: rows }).map_err(|e| e.to_string()) }
}

pub fn kill(id: &str) -> Result<(), String> {
    let pty = PTYS.lock().map_err(|e| e.to_string())?.remove(id);
    if let Some(pty) = pty {
        unsafe {
            let _ = TerminateProcess(HANDLE(pty.process as *mut _), 0);
            let _ = CloseHandle(HANDLE(pty.input as *mut _));
            ClosePseudoConsole(pty.hpc);
        }
    }
    Ok(())
}

pub fn kill_all() {
    let all: Vec<Pty> = PTYS
        .lock()
        .map(|mut g| g.drain().map(|(_, v)| v).collect())
        .unwrap_or_default();
    for pty in all {
        unsafe {
            let _ = TerminateProcess(HANDLE(pty.process as *mut _), 0);
            let _ = CloseHandle(HANDLE(pty.input as *mut _));
            ClosePseudoConsole(pty.hpc);
        }
    }
}

#[cfg(test)]
mod tests;
