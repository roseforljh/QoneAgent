import type { ToolCall } from "../store";
import { openManagedBrowserInDock } from "../store/app-bridge";
import { openBrowserInDock } from "./browser-dock";
import { useBrowserTasks, type AgentBrowserTask } from "./browser-tasks";

/** 判断工具是否驱动 Qone 内置浏览器（不含纯本地目录查询 qone_opencli_discover）。 */
export function isBuiltInBrowserTool(toolName: string): boolean {
  return toolName.startsWith("qone_browser_")
    || toolName === "qone_opencli_run"
    || toolName.startsWith("qone_twitter_");
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** 从工具参数或结果中提取网页 URL（兼容 qone_browser_open 与 qone_opencli_run）。 */
export function browserUrlFromTool(args: unknown, result?: unknown): string | undefined {
  const input = asObject(args);
  if (typeof input.url === "string" && /^https?:\/\//i.test(input.url.trim())) return input.url.trim();
  if (Array.isArray(input.args)) {
    const found = input.args.find((item): item is string => typeof item === "string" && /^https?:\/\//i.test(item.trim()));
    if (found) return found.trim();
  }
  const res = asObject(result);
  if (typeof res.url === "string" && /^https?:\/\//i.test(res.url.trim())) return res.url.trim();
  return undefined;
}

/** 将完整网址压缩为卡片与时间线易读的域名+路径形式。 */
export function formatBrowserTarget(url: string | undefined, fallback: string): string {
  const raw = url?.trim();
  if (!raw) return fallback;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./i, "");
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
    const combined = `${host}${pathname}`;
    return combined.length > 48 ? `${combined.slice(0, 47)}…` : combined;
  } catch {
    return raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
  }
}

/** 获取当前会话最近一次活跃或刚创建的内置浏览器任务。 */
export function latestBrowserTaskForSession(tasks: readonly AgentBrowserTask[], sessionId: string | undefined): AgentBrowserTask | undefined {
  if (!sessionId) return undefined;
  let best: AgentBrowserTask | undefined;
  for (const task of tasks) {
    if (task.sessionId !== sessionId) continue;
    if (!best || (Number(task.active) > Number(best.active)) || (task.active === best.active && task.updatedAt > best.updatedAt)) {
      best = task;
    }
  }
  return best;
}

/** 单击右上角任务卡片或时间线下划线时，优先接管当前会话存活的内置浏览器，否则按网址在右侧栏打开。 */
export function openBuiltInBrowserTask(sessionId: string | undefined, target?: { browserId?: string; url?: string }): void {
  const task = target?.browserId
    ? useBrowserTasks.getState().tasks.find((item) => item.id === target.browserId)
    : latestBrowserTaskForSession(useBrowserTasks.getState().tasks, sessionId);
  const browserId = target?.browserId ?? task?.id;
  const url = target?.url || task?.url || "https://www.bing.com";
  if (browserId) {
    openManagedBrowserInDock(browserId, url, sessionId);
    return;
  }
  openBrowserInDock(url, sessionId);
}

export interface NestedBrowserActivity {
  toolCallId: string;
  toolName: string;
  url?: string;
  running: boolean;
  failed: boolean;
}

const nestedIndexes = new WeakMap<readonly ToolCall[], Map<string, NestedBrowserActivity>>();

/** 汇总 codemode 内部嵌套调用的内置浏览器步骤，每段脚本仅展示一条合并后的下划线入口。 */
export function nestedBrowserActivitiesByParent(calls: readonly ToolCall[]): Map<string, NestedBrowserActivity> {
  let indexed = nestedIndexes.get(calls);
  if (indexed) return indexed;
  indexed = new Map<string, NestedBrowserActivity>();
  for (const call of calls) {
    if (!call.parentToolCallId || !isBuiltInBrowserTool(call.toolName)) continue;
    const url = browserUrlFromTool(call.args, call.result);
    const prev = indexed.get(call.parentToolCallId);
    const running = call.status === "running" || call.status === "waiting";
    const failed = call.status === "failed";
    indexed.set(call.parentToolCallId, {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      url: url ?? prev?.url,
      running: running || Boolean(prev?.running),
      failed: !running && (failed || Boolean(prev?.failed && !url)),
    });
  }
  nestedIndexes.set(calls, indexed);
  return indexed;
}
