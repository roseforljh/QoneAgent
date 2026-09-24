import { dlopen, FFIType, ptr } from "bun:ffi";

// A non-inheritable job handle belongs only to this launcher. Windows closes
// it even if `bun run` terminates the launcher before JS signal handlers run.
// Every descendant (including detached CLI, Cargo, Vite and WebView2) stays
// in the job and is then terminated by the OS, without scanning other apps.
export function ownWindowsDevProcesses() {
  const kernel = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
    SetInformationJobObject: { args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    GetCurrentProcess: { args: [], returns: FFIType.ptr },
    GetLastError: { args: [], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  const api = kernel.symbols;
  const job = api.CreateJobObjectW(null, null);
  if (!job) throw new Error(`CreateJobObjectW failed: ${api.GetLastError()}`);

  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows (x64/arm64).
  const limits = new Uint8Array(144);
  new DataView(limits.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!api.SetInformationJobObject(job, 9, ptr(limits), limits.byteLength)
    || !api.AssignProcessToJobObject(job, api.GetCurrentProcess())) {
    const error = api.GetLastError();
    api.CloseHandle(job);
    kernel.close();
    throw new Error(`Unable to supervise Tauri development processes: ${error}`);
  }

  // Keep both the library and handle alive until the launcher exits. Closing
  // the job explicitly here would also terminate the launcher itself.
  return { kernel, job };
}
