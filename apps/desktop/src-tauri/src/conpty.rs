// Windows ConPTY implementation. Owns pseudo-console lifecycle:
// spawn shell attached to a ConPTY, stream output via "terminal.data" events,
// accept writes / resize / kill.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
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

pub fn spawn(
    id: &str,
    shell: &str,
    cwd: Option<&str>,
    cols: i16,
    rows: i16,
    app: &AppHandle,
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
        si.lpAttributeList = attr_list;

        let mut cmd = to_wide(shell);
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

        // Reader thread: ConPTY output -> "terminal.data" events.
        let id_owned = id.to_string();
        let app2 = app.clone();
        let out_raw = out_read.0 as usize;
        let process_raw = pi.hProcess.0 as usize;
        let hpc_for_reader = hpc;
        let input_for_reader = in_write.0 as usize;
        std::thread::spawn(move || {
            let h = HANDLE(out_raw as *mut _);
            let mut buf = [0u8; 8192];
            loop {
                let mut n = 0u32;
                if ReadFile(h, Some(&mut buf), Some(&mut n), None).is_err() || n == 0 {
                    break;
                }
                let data = String::from_utf8_lossy(&buf[..n as usize]).to_string();
                let _ = app2.emit(
                    "terminal.data",
                    serde_json::json!({ "terminalId": id_owned, "data": data }),
                );
            }
            let _ = CloseHandle(h);
            // A natural process exit leaves the terminal registered unless the
            // reader removes it here. If kill() won the race, its handles were
            // already closed and the identity check prevents double cleanup.
            let removed = PTYS.lock().ok().and_then(|mut terminals| {
                if terminals.get(&id_owned).map(|pty| pty.process) == Some(process_raw) {
                    terminals.remove(&id_owned)
                } else {
                    None
                }
            });
            if removed.is_some() {
                let _ = CloseHandle(HANDLE(input_for_reader as *mut _));
                let _ = ClosePseudoConsole(hpc_for_reader);
            }
            let _ = CloseHandle(HANDLE(process_raw as *mut _));
            let _ = app2.emit(
                "terminal.exit",
                serde_json::json!({ "terminalId": id_owned }),
            );
        });

        Ok(())
    }
}

pub fn write(id: &str, data: &str) -> Result<(), String> {
    let guard = PTYS.lock().map_err(|e| e.to_string())?;
    let pty = guard.get(id).ok_or("no such terminal")?;
    unsafe {
        let h = HANDLE(pty.input as *mut _);
        let mut written = 0u32;
        WriteFile(h, Some(data.as_bytes()), Some(&mut written), None)
            .map_err(|e| format!("WriteFile: {e}"))?;
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
