import { create } from "zustand";
import type { AutomationCommand, RuntimeCommand, RuntimeEvent, ScheduleInfo, ScheduleRunInfo } from "@qone/protocol";
import { localizeError } from "./error-localization";

type ScheduleCommand = Extract<AutomationCommand, { type: `schedule.${string}` }>;
type ScheduleCommandInput<C = ScheduleCommand> = C extends unknown ? Omit<C, "requestId"> : never;

export const useScheduleStore = create<{ loaded: boolean; schedules: ScheduleInfo[]; runs: ScheduleRunInfo[]; error?: string }>(() => ({ loaded: false, schedules: [], runs: [] }));
const requests = new Map<string, (ok: boolean) => void>();

/** Resolves on the runtime's answer, so the editor stays open when a save is rejected. */
export function sendScheduleCommand(command: ScheduleCommandInput, send: (command: RuntimeCommand) => Promise<boolean>): Promise<boolean> {
  const requestId = crypto.randomUUID();
  useScheduleStore.setState({ error: undefined });
  const result = new Promise<boolean>((resolve) => requests.set(requestId, resolve));
  send({ ...command, requestId } as RuntimeCommand).then(
    (sent) => { if (!sent) finish(requestId, "disconnected"); },
    (error) => finish(requestId, localizeError(error)),
  );
  return result;
}

function finish(requestId: string | undefined, error?: string): boolean {
  const resolve = requestId ? requests.get(requestId) : undefined;
  if (!resolve) return false;
  requests.delete(requestId!);
  if (error) useScheduleStore.setState({ error });
  resolve(!error);
  return true;
}

export function dispatchScheduleList(message: Extract<RuntimeEvent, { type: "schedule.list" }>): void {
  useScheduleStore.setState({ loaded: true, schedules: message.schedules, runs: message.runs ?? [] });
  finish(message.requestId);
}

export function dispatchScheduleError(requestId: string | undefined, message: string): boolean {
  return finish(requestId, message);
}
