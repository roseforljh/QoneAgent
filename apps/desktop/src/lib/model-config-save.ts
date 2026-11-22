import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

type SaveCommand = Extract<RuntimeCommand, { type: "model.upsert" | "model.delete" | "secret.set" }>;
const acknowledgements = { "model.upsert": "model.updated", "model.delete": "pong", "secret.set": "secret.saved" } as const;
const pending = new Map<string, (event?: RuntimeEvent) => void>();

export function saveModelConfig(command: SaveCommand, send: (command: RuntimeCommand) => Promise<boolean>): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (event?: RuntimeEvent) => {
      clearTimeout(timer);
      pending.delete(command.requestId);
      if (event?.type === acknowledgements[command.type]) resolve();
      else reject(new Error(event?.type === "error" ? event.message : "Model configuration save failed"));
    };
    const timer = setTimeout(finish, 15_000);
    pending.set(command.requestId, finish);
    void send(command).then((sent) => { if (!sent) finish(); }, () => finish());
  });
}

export function settleModelConfigSave(event: RuntimeEvent): boolean {
  if (!("requestId" in event) || !event.requestId) return false;
  const finish = pending.get(event.requestId);
  if (!finish) return false;
  finish(event);
  return true;
}
