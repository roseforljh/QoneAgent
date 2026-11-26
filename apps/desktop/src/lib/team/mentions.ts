import type { TeamBot, TeamMentionRef } from "./types";

/** 光标位置检测到的未闭合 @ 触发片段。 */
export interface ActiveMentionQuery {
  /** '@' 字符在文本中的起始下标。 */
  start: number;
  /** 当前光标位置（结束下标）。 */
  end: number;
  /** '@' 之后已输入的筛选关键词。 */
  query: string;
}

/** 渲染消息正文时拆分的文本或高亮提及片段。 */
export type MessageTextSegment =
  | { kind: "text"; start: number; value: string }
  | { kind: "mention"; start: number; value: string; ref?: TeamMentionRef };

const BOUNDARY_BEFORE_AT = /(^|[\s([{"'，。！？；：、])$/;

/**
 * 检测输入框光标前是否正处于 `@关键词` 输入态。
 * 忽略邮箱地址（如 foo@bar）以避免误触发。
 */
export function detectActiveMention(text: string, caret: number): ActiveMentionQuery | null {
  const safeCaret = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, safeCaret);
  const atIndex = before.lastIndexOf("@");
  if (atIndex === -1) return null;
  const prefix = before.slice(0, atIndex);
  if (prefix.length > 0 && !BOUNDARY_BEFORE_AT.test(prefix)) return null;
  const query = before.slice(atIndex + 1);
  // 提及关键词不允许跨空白或换行，避免普通句子中的 @ 长时间锁住弹层。
  if (/[\s\r\n]/.test(query)) return null;
  return { start: atIndex, end: safeCaret, query };
}

/** 将选中的 @标签 写回输入文本并返回新的光标位置。 */
export function applyMentionSelection(
  text: string,
  active: ActiveMentionQuery,
  label: string,
): { nextText: string; nextCaret: number } {
  const inserted = `@${label} `;
  const nextText = `${text.slice(0, active.start)}${inserted}${text.slice(active.end)}`;
  return { nextText, nextCaret: active.start + inserted.length };
}

/** 按最长名称优先匹配正文中的 @全体 与 @机器人，去重后返回结构化提及列表。 */
export function extractMentionsFromText(
  text: string,
  members: readonly TeamBot[],
  allLabels: readonly string[],
): TeamMentionRef[] {
  const candidates: Array<{ token: string; ref: TeamMentionRef }> = [
    ...allLabels.map((label) => ({
      token: `@${label}`,
      ref: { kind: "all" as const, targetId: "all", label },
    })),
    ...members.map((bot) => ({
      token: `@${bot.name}`,
      ref: { kind: "bot" as const, targetId: bot.id, label: bot.name },
    })),
  ].sort((left, right) => right.token.length - left.token.length);

  const matched: Array<{ start: number; end: number; ref: TeamMentionRef }> = [];
  const seen = new Set<string>();
  const lower = text.toLocaleLowerCase();

  for (const candidate of candidates) {
    const needle = candidate.token.toLocaleLowerCase();
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(needle, from);
      if (idx === -1) break;
      const end = idx + candidate.token.length;
      const overlaps = matched.some((span) => idx < span.end && end > span.start);
      const before = idx === 0 ? "" : text.slice(0, idx);
      const afterChar = text[end] ?? "";
      const validBefore = before.length === 0 || BOUNDARY_BEFORE_AT.test(before);
      const validAfter = !afterChar || /[\s.,!?;:()[\]{}"'，。！？；：、]/.test(afterChar);
      if (!overlaps && validBefore && validAfter) {
        const key = `${candidate.ref.kind}:${candidate.ref.targetId}`;
        if (!seen.has(key)) {
          seen.add(key);
          matched.push({ start: idx, end, ref: candidate.ref });
        }
        break;
      }
      from = idx + 1;
    }
  }
  return matched.sort((left, right) => left.start - right.start).map((item) => item.ref);
}

/** 把消息正文拆分为普通文本与 @高亮片段，供气泡内安全渲染。 */
export function splitMessageByMentions(
  text: string,
  mentions: readonly TeamMentionRef[],
): MessageTextSegment[] {
  if (!text || mentions.length === 0) return [{ kind: "text", start: 0, value: text }];
  const sorted = [...mentions].sort((left, right) => right.label.length - left.label.length);
  const pattern = new RegExp(
    sorted.map((item) => `@${escapeRegExp(item.label)}`).join("|"),
    "gi",
  );
  const segments: MessageTextSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const raw = match[0];
    if (start > cursor) segments.push({ kind: "text", start: cursor, value: text.slice(cursor, start) });
    const matchedRef = sorted.find((item) => `@${item.label}`.toLocaleLowerCase() === raw.toLocaleLowerCase());
    segments.push({ kind: "mention", start, value: raw, ref: matchedRef });
    cursor = start + raw.length;
  }
  if (cursor < text.length) segments.push({ kind: "text", start: cursor, value: text.slice(cursor) });
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
