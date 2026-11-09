// Starts agent-runtime + Electron desktop together.
const desktop = Bun.spawn(["bun", "run", "--cwd", "apps/desktop", "dev"], {
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
