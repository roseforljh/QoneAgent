import { expect, test } from "bun:test";
import { once } from "node:events";
import type { Worker } from "node:worker_threads";
import type { IPty } from "node-pty";
import { installElectronMock } from "./helpers/electron-mock";

installElectronMock();
const { TerminalManager } = await import("../electron/terminal-manager");

for (const exit of ["natural", "before-connect"] as const) test(`${exit} terminal exit releases its output worker and input pipe`, async () => {
  const manager = new TerminalManager(() => null);
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    manager.spawn("natural", "cmd.exe", undefined, 80, 24, ["/d", "/c", "echo finished"]);
    const child = (manager as unknown as { sessions: Map<string, { process: IPty & { _agent: { inSocket: { destroyed: boolean }; _conoutSocketWorker: { _worker: Worker } } } }> }).sessions.get("natural")!.process;
    worker = child._agent._conoutSocketWorker._worker;
    const stopped = once(worker, "exit");
    if (exit === "before-connect") await manager.kill("natural");
    await Promise.race([
      stopped,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("PTY worker survived natural shell exit")), 5_000); }),
    ]);
    expect(worker.threadId).toBe(-1);
    expect(child._agent.inSocket.destroyed).toBe(true);
  } finally {
    clearTimeout(timer);
    await manager.kill("natural");
    await worker?.terminate();
  }
}, 10_000);
