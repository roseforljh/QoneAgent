const TITLE_LIMIT = 40;
const TITLE_PROMPT_MAX_CHARS = 4000;
const TITLE_PROMPT_HEAD_CHARS = 3000;
const TITLE_PROMPT_TAIL_CHARS = 1000;

export function provisionalSessionTitle(prompt: string): string {
  return Array.from(prompt.replace(/\s+/g, " ").trim()).slice(0, TITLE_LIMIT).join("") || "New session";
}

/** 限制超大粘贴内容的长度，保留首尾上下文，确保标题生成快速稳定。 */
export function prepareTitlePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length <= TITLE_PROMPT_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, TITLE_PROMPT_HEAD_CHARS).trimEnd()}\n...\n${trimmed.slice(-TITLE_PROMPT_TAIL_CHARS).trimStart()}`;
}

function parseTitlePayload(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = (fenced ? fenced[1]! : trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    // 兼容模型在 JSON 前后附加说明或非标准围栏的情况，仅提取包含 title 字段的 JSON 对象。
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export function generatedSessionTitle(value: string): string | undefined {
  const parsed = parseTitlePayload(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { title?: unknown }).title !== "string") return undefined;
  const rawTitle = (parsed as { title: string }).title.trim();
  if (!rawTitle || /[\r\n]/.test(rawTitle) || /\*\*|```/.test(rawTitle)) return undefined;
  const title = rawTitle
    .replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || Array.from(title).length > TITLE_LIMIT) return undefined;
  return title;
}
