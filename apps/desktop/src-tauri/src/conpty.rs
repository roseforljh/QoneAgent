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
    cols: i16,
    rows: i16,
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

// RAII guard for native Win32 HANDLEs.
struct HandleGuard(HANDLE);

impl HandleGuard {
    fn new(h: HANDLE) -> Self {
        Self(h)
    }

    fn is_valid(&self) -> bool {
        !self.0 .0.is_null() && self.0 != INVALID_HANDLE_VALUE
    }

    fn handle(&self) -> HANDLE {
        self.0
    }

    fn into_raw(mut self) -> HANDLE {
        let h = self.0;
        self.0 = HANDLE::default();
        h
    }

    fn close(&mut self) {
        if self.is_valid() {
            unsafe {
                let _ = CloseHandle(self.0);
            }
            self.0 = HANDLE::default();
        }
    }
}

impl Default for HandleGuard {
    fn default() -> Self {
        Self(HANDLE::default())
    }
}

impl Drop for HandleGuard {
    fn drop(&mut self) {
        self.close();
    }
}

// RAII guard for HPCON pseudo-consoles.
struct PseudoConsoleGuard(HPCON);

impl PseudoConsoleGuard {
    fn new(hpc: HPCON) -> Self {
        Self(hpc)
    }

    fn is_valid(&self) -> bool {
        self.0 .0 != 0
    }

    fn handle(&self) -> HPCON {
        self.0
    }

    fn into_raw(mut self) -> HPCON {
        let hpc = self.0;
        self.0 = HPCON::default();
        hpc
    }

    fn close(&mut self) {
        if self.is_valid() {
            unsafe {
                ClosePseudoConsole(self.0);
            }
            self.0 = HPCON::default();
        }
    }
}

impl Default for PseudoConsoleGuard {
    fn default() -> Self {
        Self(HPCON::default())
    }
}

impl Drop for PseudoConsoleGuard {
    fn drop(&mut self) {
        self.close();
    }
}

// RAII guard for LPPROC_THREAD_ATTRIBUTE_LIST with correctly aligned buffer (Vec<usize>)
// ensuring proper pointer-alignment on 64-bit platforms and cleanup lifetime.
struct ProcThreadAttributeListGuard {
    _buffer: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl ProcThreadAttributeListGuard {
    fn new(attribute_count: u32) -> Result<Self, String> {
        unsafe {
            let mut attr_size = 0usize;
            let _ = InitializeProcThreadAttributeList(None, attribute_count, None, &mut attr_size);
            if attr_size == 0 {
                return Err("InitializeProcThreadAttributeList failed to calculate size".into());
            }
            let usize_count =
                (attr_size + std::mem::size_of::<usize>() - 1) / std::mem::size_of::<usize>();
            let mut buffer = vec![0usize; usize_count];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr() as *mut _);
            InitializeProcThreadAttributeList(Some(list), attribute_count, None, &mut attr_size)
                .map_err(|e| format!("InitAttrList: {e}"))?;
            Ok(Self {
                _buffer: buffer,
                list,
            })
        }
    }

    fn as_list(&self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.list
    }
}

impl Drop for ProcThreadAttributeListGuard {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.list);
        }
    }
}

#[derive(Default)]
struct SpawnCleanup {
    in_read: HandleGuard,
    in_write: HandleGuard,
    out_read: HandleGuard,
    out_write: HandleGuard,
    hpc: PseudoConsoleGuard,
    process: HandleGuard,
}

impl SpawnCleanup {
    fn abort(self) {
        if self.process.is_valid() {
            unsafe {
                let _ = TerminateProcess(self.process.handle(), 0);
            }
        }
        // Dropping self closes process handle, hpc, and all open pipe handles.
    }
}

struct CreatedProcess {
    in_write: HANDLE,
    out_read: HANDLE,
    hpc: HPCON,
    process: HANDLE,
}

unsafe fn create_conpty_process(
    shell: &str,
    cwd: Option<&str>,
    cols: i16,
    rows: i16,
) -> Result<CreatedProcess, (String, SpawnCleanup)> {
    let mut cleanup = SpawnCleanup::default();

    // Pipe 1: our write -> conpty input. Pipe 2: conpty output -> our read.
    let mut in_read = HANDLE::default();
    let mut in_write = HANDLE::default();
    if let Err(e) = CreatePipe(&mut in_read, &mut in_write, None, 0) {
        return Err((format!("CreatePipe (input): {e}"), cleanup));
    }
    cleanup.in_read = HandleGuard::new(in_read);
    cleanup.in_write = HandleGuard::new(in_write);

    let mut out_read = HANDLE::default();
    let mut out_write = HANDLE::default();
    if let Err(e) = CreatePipe(&mut out_read, &mut out_write, None, 0) {
        return Err((format!("CreatePipe (output): {e}"), cleanup));
    }
    cleanup.out_read = HandleGuard::new(out_read);
    cleanup.out_write = HandleGuard::new(out_write);

    let hpc = match CreatePseudoConsole(
        COORD { X: cols, Y: rows },
        cleanup.in_read.handle(),
        cleanup.out_write.handle(),
        0,
    ) {
        Ok(hpc) => hpc,
        Err(e) => return Err((format!("CreatePseudoConsole: {e}"), cleanup)),
    };
    cleanup.hpc = PseudoConsoleGuard::new(hpc);

    // ConPTY owns these ends now; close them immediately.
    cleanup.in_read.close();
    cleanup.out_write.close();

    // Attribute list carrying PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE.
    let attr_guard = match ProcThreadAttributeListGuard::new(1) {
        Ok(guard) => guard,
        Err(e) => return Err((e, cleanup)),
    };

    if let Err(e) = UpdateProcThreadAttribute(
        attr_guard.as_list(),
        0,
        PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
        Some(cleanup.hpc.handle().0 as *const _),
        std::mem::size_of::<HPCON>(),
        None,
        None,
    ) {
        return Err((format!("UpdateProcAttr: {e}"), cleanup));
    }

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
    si.lpAttributeList = attr_guard.as_list();

    let command = shell_command(shell);
    let mut cmd = to_wide(&command);
    let cwd_v = cwd.map(to_wide);
    let mut pi = PROCESS_INFORMATION::default();

    let create_result = CreateProcessW(
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
    );

    // Attribute list is no longer needed after CreateProcessW; drop it explicitly.
    drop(attr_guard);

    if let Err(e) = create_result {
        return Err((format!("CreateProcessW: {e}"), cleanup));
    }

    let _ = CloseHandle(pi.hThread);
    cleanup.process = HandleGuard::new(pi.hProcess);

    Ok(CreatedProcess {
        in_write: cleanup.in_write.into_raw(),
        out_read: cleanup.out_read.into_raw(),
        hpc: cleanup.hpc.into_raw(),
        process: cleanup.process.into_raw(),
    })
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
    if cols <= 0 || rows <= 0 {
        return Err("terminal dimensions must be positive".into());
    }

    let mut registry = PTYS.lock().map_err(|e| e.to_string())?;
    if registry.contains_key(id) {
        return Err(format!("terminal {id} already exists"));
    }

    let created = match unsafe { create_conpty_process(shell, cwd, cols, rows) } {
        Ok(res) => res,
        Err((err, cleanup)) => {
            // Drop registry lock before running any cleanup that could block on ConPTY.
            drop(registry);
            cleanup.abort();
            return Err(err);
        }
    };

    let pty = Pty {
        hpc: created.hpc,
        input: created.in_write.0 as usize,
        process: created.process.0 as usize,
        cols,
        rows,
    };
    registry.insert(id.to_string(), pty);

    // Release registry lock before spawning threads.
    drop(registry);

    let id_owned = id.to_string();
    let out_raw = created.out_read.0 as usize;
    let process_raw = created.process.0 as usize;

    // Reader thread: ConPTY output -> "terminal:data" events.
    let reader_id = id_owned.clone();
    let reader_emit = emit.clone();
    std::thread::spawn(move || {
        let h = HANDLE(out_raw as *mut _);
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            let mut n = 0u32;
            if unsafe { ReadFile(h, Some(&mut buf), Some(&mut n), None) }.is_err() || n == 0 {
                break;
            }
            pending.extend_from_slice(&buf[..n as usize]);
            let data = decode_output(&mut pending, false);
            reader_emit(
                "terminal:data",
                serde_json::json!({ "terminalId": reader_id, "data": data }),
            );
        }
        if !pending.is_empty() {
            reader_emit(
                "terminal:data",
                serde_json::json!({ "terminalId": reader_id, "data": decode_output(&mut pending, true) }),
            );
        }
        let _ = unsafe { CloseHandle(h) };
    });

    // Wait independently of the output pipe. A natural shell exit does not
    // close ConPTY's pipe until ClosePseudoConsole is called; keep the reader
    // draining during that call to avoid a full-pipe deadlock.
    let waiter_id = id_owned;
    let waiter_emit = emit;
    std::thread::spawn(move || {
        let process = HANDLE(process_raw as *mut _);
        unsafe { WaitForSingleObject(process, u32::MAX) };
        let removed = PTYS.lock().ok().and_then(|mut terminals| {
            if terminals.get(&waiter_id).map(|pty| pty.process) == Some(process_raw) {
                terminals.remove(&waiter_id)
            } else {
                None
            }
        });
        if let Some(pty) = removed {
            unsafe {
                let _ = CloseHandle(HANDLE(pty.input as *mut _));
                ClosePseudoConsole(pty.hpc);
            }
            waiter_emit(
                "terminal:exit",
                serde_json::json!({ "terminalId": waiter_id }),
            );
        }
        let _ = unsafe { CloseHandle(process) };
    });

    Ok(())
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
    if cols <= 0 || rows <= 0 {
        return Err("terminal dimensions must be positive".into());
    }
    let mut guard = PTYS.lock().map_err(|e| e.to_string())?;
    let pty = guard.get_mut(id).ok_or("no such terminal")?;
    if pty.cols == cols && pty.rows == rows {
        return Ok(());
    }
    unsafe {
        ResizePseudoConsole(pty.hpc, COORD { X: cols, Y: rows }).map_err(|e| e.to_string())?;
    }
    pty.cols = cols;
    pty.rows = rows;
    Ok(())
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
