import { localizeError } from "../lib/error-localization";
export type TerminalStatus = "starting" | "ready" | "exited" | "error";
export interface TerminalSessionSnapshot { status: TerminalStatus; detail?: string }
export type TerminalInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;
export interface TerminalEvents {
  data: (data: string) => void;
  exit: () => void;
}
export interface TerminalSessionOptions {
  terminalId: string;
  cwd: string;
  dimensions: () => { cols: number; rows: number };
  invoke: TerminalInvoke;
  listen: (events: TerminalEvents) => Promise<() => void>;
  output: (data: string) => void;
}

// Owns the process, not a React mount. Detaching a renderer never closes a PTY.
// Lifecycle operations stay ordered, but never wait for a blocked input pipe.
export function createDockTerminalSession(options: TerminalSessionOptions) {
  let disposed = false;
  let started = false;
  let restarting = false;
  let snapshot: TerminalSessionSnapshot = { status: "starting" };
  const subscribers = new Set<(state: TerminalSessionSnapshot) => void>();
  let queue: Promise<unknown> = Promise.resolve();
  let inputQueue: Promise<unknown> = Promise.resolve();
  let generation = 0;
  const pendingInput: string[] = [];
  const setStatus = (status: TerminalStatus, detail?: string) => {
    if (disposed) return;
    snapshot = { status, detail };
    for (const listener of subscribers) listener(snapshot);
  };
  const enqueue = (operation: () => Promise<unknown>) => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };
  const enqueueInput = (operation: () => Promise<unknown>) => {
    const result = inputQueue.then(operation);
    inputQueue = result.catch(() => undefined);
    return result;
  };
  const events = options.listen({
    data: (data) => { if (!disposed) options.output(data); },
    exit: () => {
      if (disposed || restarting) return;
      pendingInput.length = 0;
      setStatus("exited");
      options.output("\r\n[process exited]\r\n");
    },
  });
  // A rejection is still propagated to start(), but is always observed.
  void events.catch(() => undefined);
  const write = (data: string) => {
    if (disposed) return;
    if (snapshot.status === "starting") { pendingInput.push(data); return; }
    if (snapshot.status !== "ready") return;
    const writeGeneration = generation;
    void enqueueInput(async () => {
      if (disposed || snapshot.status !== "ready" || writeGeneration !== generation) return;
      await options.invoke("terminal_write", { terminalId: options.terminalId, data });
    }).catch((error) => { if (writeGeneration === generation && !restarting) setStatus("error", localizeError(error)); });
  };
  const spawn = async (restart: boolean) => {
    if (disposed) return;
    restarting = true;
    generation++;
    setStatus("starting");
    try {
      await events; // Never create a process before output listeners are registered.
      if (disposed) return;
      if (restart) await options.invoke("terminal_kill", { terminalId: options.terminalId });
      if (disposed) return;
      await options.invoke("terminal_spawn", { terminalId: options.terminalId, shell: "pwsh.exe -NoProfile", cwd: options.cwd, ...options.dimensions() });
      if (disposed) return; // dispose's queued kill runs after spawn settles.
      setStatus("ready");
      for (const data of pendingInput.splice(0)) write(data);
    } catch (error) {
      pendingInput.length = 0;
      setStatus("error", localizeError(error));
      if (!disposed) options.output(`\r\nterminal failed: ${localizeError(error)}\r\n`);
    } finally { restarting = false; }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (state: TerminalSessionSnapshot) => void) {
      subscribers.add(listener);
      listener(snapshot);
      return () => { subscribers.delete(listener); };
    },
    start() {
      if (started || disposed) return queue;
      started = true;
      return enqueue(() => spawn(false));
    },
    restart() {
      if (disposed || restarting) return queue;
      started = true;
      return enqueue(() => spawn(true));
    },
    write,
    resize() {
      if (disposed || snapshot.status !== "ready") return;
      const resizeGeneration = generation;
      void enqueueInput(async () => {
        if (!disposed && snapshot.status === "ready" && resizeGeneration === generation) await options.invoke("terminal_resize", { terminalId: options.terminalId, ...options.dimensions() });
      }).catch((error) => { if (resizeGeneration === generation && !restarting) setStatus("error", localizeError(error)); });
    },
    dispose() {
      if (disposed) return queue;
      disposed = true;
      subscribers.clear();
      pendingInput.length = 0;
      void events.then((off) => off()).catch(() => undefined);
      return enqueue(() => options.invoke("terminal_kill", { terminalId: options.terminalId }));
    },
  };
}
