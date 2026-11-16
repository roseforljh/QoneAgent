import { create } from "zustand";
import type { RuntimeCommand, RuntimeEvent, ServerCandidate, ServerGroupInfo, ServerInfo, ServerSetupStage, ServerTunnelInfo } from "@qone/protocol";
import { localizeError } from "./error-localization";

type ServerCommandInput<C = Extract<RuntimeCommand, { type: `servers.${string}` }>> = C extends unknown ? Omit<C, "requestId"> : never;

interface ServerState {
  loaded: boolean;
  servers: ServerInfo[];
  groups: ServerGroupInfo[];
  tunnels: ServerTunnelInfo[];
  /** A group the user just created; its name opens for editing. */
  editingGroupId?: string;
  /** Live progress of the add flow, keyed by its request. */
  setup?: { requestId: string; stage: ServerSetupStage };
  candidates?: ServerCandidate[];
  pending: number;
  error?: string;
}

export const useServerStore = create<ServerState>(() => ({ loaded: false, servers: [], groups: [], tunnels: [], pending: 0 }));
const requests = new Map<string, (ok: boolean) => void>();

/** Resolves on the runtime's answer, so forms stay open when the server rejects them. */
export function sendServerCommand(command: ServerCommandInput, send: (command: RuntimeCommand) => Promise<boolean>): Promise<boolean> {
  const requestId = crypto.randomUUID();
  useServerStore.setState((state) => ({ pending: state.pending + 1, error: undefined, ...(command.type === "servers.add" ? { setup: undefined } : {}) }));
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
  useServerStore.setState((state) => ({
    pending: Math.max(0, state.pending - 1),
    ...(error ? { error } : {}),
    ...(state.setup?.requestId === requestId ? { setup: undefined } : {}),
  }));
  resolve(!error);
  return true;
}

export function dispatchServerEvent(message: Extract<RuntimeEvent, { type: "servers.state" | "servers.setup" | "servers.discovered" }>): void {
  if (message.type === "servers.setup") { useServerStore.setState({ setup: { requestId: message.requestId, stage: message.stage } }); return; }
  if (message.type === "servers.discovered") useServerStore.setState({ candidates: message.candidates });
  else useServerStore.setState({ loaded: true, servers: message.servers, groups: message.groups, tunnels: message.tunnels, ...(message.createdGroupId ? { editingGroupId: message.createdGroupId } : {}) });
  finish(message.requestId);
}

export function dispatchServerError(requestId: string | undefined, message: string): boolean {
  return finish(requestId, message);
}

export const OPEN_SERVER_TERMINAL_EVENT = "qone-open-server-terminal";
export const openServerTerminal = (serverId: string) => window.dispatchEvent(new CustomEvent(OPEN_SERVER_TERMINAL_EVENT, { detail: serverId }));
