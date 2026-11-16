import type { ClaudeCodeSyncResult, ClaudeCodeSyncTarget, RuntimeCommand } from "@qone/protocol";
import { translateCurrent as t } from "../localization";

const requests = new Map<string, { resolve: (result: ClaudeCodeSyncResult) => void; reject: (error: Error) => void }>();
export function requestClaudeSync(target: ClaudeCodeSyncTarget, send: (command: RuntimeCommand) => Promise<boolean>, revision?: string, remove?: boolean): Promise<ClaudeCodeSyncResult> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => dispatchClaudeSyncError(requestId, t("claudeSync.timeout")), 60_000);
    requests.set(requestId, {
      resolve: result => { clearTimeout(timer); requests.delete(requestId); resolve(result); },
      reject: error => { clearTimeout(timer); requests.delete(requestId); reject(error); },
    });
    void send({ type: "claude-code.sync", requestId, target, ...(revision !== undefined ? { apply: true, revision } : {}), ...(remove ? { remove } : {}) }).then(
      sent => { if (!sent) dispatchClaudeSyncError(requestId, t("error.runtimeUnavailable")); },
      () => dispatchClaudeSyncError(requestId, t("error.runtimeUnavailable")),
    );
  });
}
export function dispatchClaudeSync(message: { requestId: string; result: ClaudeCodeSyncResult }) {
  requests.get(message.requestId)?.resolve(message.result);
}
export function dispatchClaudeSyncError(requestId: string | undefined, message: string): boolean {
  const request = requestId ? requests.get(requestId) : undefined;
  if (!request) return false;
  request.reject(new Error(message));
  return true;
}
export function disconnectClaudeSync() {
  for (const request of [...requests.values()]) request.reject(new Error(t("error.runtimeExited")));
}
