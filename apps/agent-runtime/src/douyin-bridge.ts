import { douyinAuthorId, douyinContentId, isDouyinAuthorResult, isDouyinOwnerResult, isDouyinUrl, type DouyinAuthorResult, type DouyinOwnerResult, type DouyinBridgeFailure, type RuntimeMessageKey, type RuntimeCommand, type RuntimeEvent } from "@qone/protocol";
import { LocalizedRuntimeError, runtimeError } from "./runtime-localization.js";

const BRIDGE_TIMEOUT_MS = 60_000;

export interface DouyinBridgeResult {
  videoUrl: string;
  videoUrls?: string[];
  pageUrl: string;
  userAgent?: string;
}

export class DouyinBridgeError extends LocalizedRuntimeError {
  constructor(readonly failure: DouyinBridgeFailure, code: RuntimeMessageKey, values: Record<string, unknown> = {}) { super(code, values); }
}

type Send = (event: Extract<RuntimeEvent, { type: "douyin.bridge.request" | "douyin.bridge.cancel" }>) => void;
export { isDouyinUrl } from "@qone/protocol";

export class DouyinBridge {
  private readonly pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
  }>();

  constructor(private readonly send: Send) {}

  request(url: string, signal?: AbortSignal): Promise<DouyinBridgeResult> {
    const normalized = url.trim();
    if (!isDouyinUrl(normalized)) throw runtimeError("douyin-bridge.unsupported_url", {});
    return this.exchange(normalized, signal, (value) => {
      const result = value as Partial<DouyinBridgeResult> | null;
      if (!result || typeof result.videoUrl !== "string" || !/^https?:\/\//i.test(result.videoUrl)) {
        throw new DouyinBridgeError("page_unavailable", "douyin-bridge.invalid_video_url");
      }
      const expectedId = douyinContentId(normalized);
      const contentId = typeof result.pageUrl === "string" ? douyinContentId(result.pageUrl) : undefined;
      if (!contentId || expectedId && contentId !== expectedId) throw new DouyinBridgeError("page_unavailable", "douyin-bridge.content_mismatch");
      if (result.videoUrls !== undefined && (!Array.isArray(result.videoUrls) || result.videoUrls[0] !== result.videoUrl
        || result.videoUrls.some((url) => typeof url !== "string" || !/^https?:\/\//i.test(url)))) {
        throw new DouyinBridgeError("page_unavailable", "douyin-bridge.invalid_video_url");
      }
      return { videoUrl: result.videoUrl, pageUrl: result.pageUrl!,
        ...(result.videoUrls ? { videoUrls: result.videoUrls } : {}),
        ...(typeof result.userAgent === "string" ? { userAgent: result.userAgent } : {}) };
    });
  }

  listAuthor(url: string, limit: number, signal?: AbortSignal): Promise<DouyinAuthorResult> {
    const normalized = url.trim();
    if (!douyinAuthorId(normalized)) throw runtimeError("douyin-bridge.invalid_author_url", {});
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw runtimeError("douyin-bridge.invalid_limit", {});
    return this.exchange(normalized, signal, (value) => {
      if (!isDouyinAuthorResult(value, normalized, limit)) throw runtimeError("douyin-bridge.invalid_author_result", {});
      return value;
    }, limit);
  }

  resolveAuthor(url: string, signal?: AbortSignal): Promise<DouyinOwnerResult> {
    const normalized = url.trim();
    if (!isDouyinUrl(normalized)) throw runtimeError("douyin-bridge.unsupported_url", {});
    return this.exchange(normalized, signal, (value) => {
      if (!isDouyinOwnerResult(value, normalized)) throw runtimeError("douyin-bridge.invalid_author_result", {});
      return value;
    }, undefined, "owner");
  }

  private exchange<T>(url: string, signal: AbortSignal | undefined, decode: (value: unknown) => T, limit?: number, operation?: "owner"): Promise<T> {

    const requestId = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(requestId)?.cleanup();
        this.pending.delete(requestId);
        reject(new DouyinBridgeError("metadata_timeout", "douyin-bridge.page_bridge_timed_out"));
        try { this.send({ type: "douyin.bridge.cancel", requestId }); } catch { /* Transport already exited. */ }
      }, limit === undefined ? BRIDGE_TIMEOUT_MS : BRIDGE_TIMEOUT_MS * 2);
      const abort = () => {
        const current = this.pending.get(requestId);
        if (!current) return;
        clearTimeout(current.timer);
        current.cleanup();
        this.pending.delete(requestId);
        current.reject(runtimeError("douyin-bridge.download_cancelled", {}));
        try { this.send({ type: "douyin.bridge.cancel", requestId }); } catch { /* Transport already exited. */ }
      };
      this.pending.set(requestId, { resolve: (value) => resolve(decode(value)), reject, timer, cleanup: () => signal?.removeEventListener("abort", abort) });
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ type: "douyin.bridge.request", requestId, url,
        ...(limit === undefined ? operation ? { operation } : {} : { operation: "author" as const, limit }) }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.get(requestId)?.cleanup();
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  handleResponse(command: Extract<RuntimeCommand, { type: "douyin.bridge.response" }>): boolean {
    const current = this.pending.get(command.requestId);
    if (!current) return false;
    clearTimeout(current.timer);
    current.cleanup();
    this.pending.delete(command.requestId);
    if (!command.ok || !command.result) {
      current.reject(new DouyinBridgeError(command.failure || "page_unavailable", "douyin-bridge.page_bridge_failed",
        { p0: command.message || runtimeError("douyin-bridge.no_video_address", {}).message }));
      return true;
    }
    try {
      current.resolve(JSON.parse(command.result));
    } catch (error) {
      current.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }
}
