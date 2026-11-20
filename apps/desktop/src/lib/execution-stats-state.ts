import { create } from "zustand";
import type { ExecutionStatsInfo, ExecutionStatsRange, RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { localizeError } from "./error-localization";
import { translateCurrent } from "../localization";

type StatsCommand = Extract<RuntimeCommand, { type: `stats.${string}` }>;
type StatsCommandInput = StatsCommand extends infer C ? C extends StatsCommand ? Omit<C, "requestId"> : never : never;

export const useExecutionStatsStore = create<{
  /** Latest global controls and model catalog; its period is not rendered. */
  state?: ExecutionStatsInfo;
  /** Snapshots per range, so switching back never shows another period's numbers. */
  periods: Partial<Record<ExecutionStatsRange, ExecutionStatsInfo>>;
  range: ExecutionStatsRange;
  pending: number;
  error?: string;
}>(() => ({ pending: 0, periods: {}, range: "today" }));

type Request = { resolve: (ok: boolean) => void; range?: ExecutionStatsRange };
const requests = new Map<string, Request>();
/** Latest period request per range; an older answer for the same range is discarded. */
const latestGet = new Map<ExecutionStatsRange, string>();

export function sendStatsCommand(command: StatsCommandInput, send: (command: RuntimeCommand) => Promise<boolean>): Promise<boolean> {
  const requestId = crypto.randomUUID();
  const range = command.type === "stats.get" ? command.range : undefined;
  if (range) latestGet.set(range, requestId);
  useExecutionStatsStore.setState((current) => ({ pending: current.pending + 1, error: undefined, ...(range ? { range } : {}) }));
  const result = new Promise<boolean>((resolve) => requests.set(requestId, { resolve, range }));
  send({ ...command, requestId } as RuntimeCommand).then(
    (sent) => { if (!sent) finish(requestId, translateCurrent("execution.disconnected")); },
    (error) => finish(requestId, localizeError(error)),
  );
  return result;
}

/**
 * Only a `stats.get` answer may replace the visible period, and only if it is the
 * newest request for its range. A write answer keeps the real counts of the range
 * being viewed and only refreshes controls and the model catalog. Unknown ids
 * are ignored; unrequested pushes refresh controls and catalog without replacing counts.
 */
export function dispatchExecutionStatsState(message: Extract<RuntimeEvent, { type: "stats.state" }>): void {
  const request = message.requestId ? requests.get(message.requestId) : undefined;
  finish(message.requestId);
  useExecutionStatsStore.setState((current) => {
    if (request?.range) {
      if (latestGet.get(request.range) !== message.requestId) return current;
      return { ...current, state: message.state, periods: { ...current.periods, [request.range]: message.state } };
    }
    if (!current.state) return current;
    if (request || !message.requestId) return { ...current, state: withStalePeriod(current.state, message.state) };
    return current;
  });
}

/** Switch data from a write answer, with the period of the range currently on screen. */
const withStalePeriod = (previous: ExecutionStatsInfo, next: ExecutionStatsInfo): ExecutionStatsInfo => ({
  ...previous,
  models: next.models,
  recording: next.recording,
  memoryAccess: next.memoryAccess,
});

export function dispatchExecutionStatsError(requestId: string | undefined, message: string): boolean {
  return finish(requestId, message);
}

/** A dropped socket must not leave a switch busy forever. */
export function resetExecutionStatsRequests(): void {
  for (const requestId of [...requests.keys()]) finish(requestId, translateCurrent("execution.disconnected"));
  latestGet.clear();
  useExecutionStatsStore.setState({ pending: 0 });
}

function finish(requestId: string | undefined, error?: string): boolean {
  const request = requestId ? requests.get(requestId) : undefined;
  if (!request) return false;
  requests.delete(requestId!);
  useExecutionStatsStore.setState((current) => ({ pending: Math.max(0, current.pending - 1), ...(error ? { error } : {}) }));
  request.resolve(!error);
  return true;
}
