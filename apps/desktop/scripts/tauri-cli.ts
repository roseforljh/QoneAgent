import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const windowsJob = process.platform === "win32"
  ? (await import("./windows-dev-job")).ownWindowsDevProcesses()
  : undefined;

// Call the official JS entry directly; .bin/tauri.exe and .bin/node.exe
// are Windows forwarding shims, not the CLI process we need to supervise.
const command = process.execPath;
const cli = import.meta.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(command, [fileURLToPath(cli), ...Bun.argv.slice(2)], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: ["inherit", "pipe", "pipe"],
  // Keep all dev commands in the caller's console. The Windows job below owns
  // the whole descendant tree, so detaching is unnecessary and can create
  // additional console windows on Windows.
  detached: false,
  windowsHide: true,
});
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

let terminating = false;

function stop(signal: string) {
  if (terminating) return;
  terminating = true;
  console.error(`[qone:dev] received ${signal}, stopping development processes`);
  if (windowsJob) process.exit(130);
  child.kill("SIGTERM");
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const exitCode = await new Promise<number>((resolve) => {
  child.once("error", (error) => {
    console.error("Failed to start Tauri:", error);
    resolve(1);
  });
  child.once("exit", (code, signal) => {
    console.error(`[qone:dev] Tauri CLI exited (code: ${code ?? "none"}, signal: ${signal ?? "none"}, interrupted: ${terminating})`);
    resolve(terminating ? 130 : code ?? (signal ? 1 : 0));
  });
});

// Exit also closes the job if the official CLI quits while one of its
// BeforeDevCommand children still holds an inherited stdout/stderr pipe.
process.exit(exitCode);
