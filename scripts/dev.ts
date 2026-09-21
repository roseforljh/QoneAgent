// Starts agent-runtime + Tauri desktop together.
const desktop = Bun.spawn(["bun", "run", "--cwd", "apps/desktop", "tauri", "dev"], {
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit",
});

function shutdown() {
  desktop.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

process.exit(await desktop.exited);
