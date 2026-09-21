/**
 * Small runtime-neutral CPU worker facade. Bun and browsers use Web Workers;
 * callers stay independent of the concrete runtime. The function is copied
 * into the worker, so task/input must be self-contained and structured-cloneable.
 */
export async function runCpuTask<Input, Output>(
  input: Input,
  task: (value: Input) => Output,
): Promise<Output> {
  const WorkerCtor = (globalThis as unknown as { Worker?: new (url: string, options?: { type?: string }) => {
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    postMessage(value: unknown): void;
    terminate(): void;
  } }).Worker;
  if (!WorkerCtor || typeof Blob === "undefined" || typeof URL.createObjectURL !== "function") {
    return task(input);
  }

  const source = `self.onmessage = async (event) => {
    try {
      const fn = (${task.toString()});
      self.postMessage({ ok: true, value: await fn(event.data) });
    } catch (error) {
      self.postMessage({ ok: false, error: String(error) });
    }
  };`;
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  const worker = new WorkerCtor(url, { type: "module" });
  return await new Promise<Output>((resolve, reject) => {
    worker.onmessage = (event) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      const result = event.data as { ok: boolean; value?: Output; error?: string };
      if (result.ok) resolve(result.value as Output);
      else reject(new Error(result.error ?? "worker task failed"));
    };
    worker.onerror = (error) => {
      worker.terminate();
      URL.revokeObjectURL(url);
      reject(error);
    };
    worker.postMessage(input);
  });
}
