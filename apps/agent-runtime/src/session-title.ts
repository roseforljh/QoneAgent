const TITLE_LIMIT = 40;

export function provisionalSessionTitle(prompt: string): string {
  return Array.from(prompt.replace(/\s+/g, " ").trim()).slice(0, TITLE_LIMIT).join("") || "New session";
}

export function generatedSessionTitle(value: string): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { title?: unknown }).title !== "string") return undefined;
  const title = (parsed as { title: string }).title.trim();
  if (!title || /[\r\n]/.test(title) || Array.from(title).length > TITLE_LIMIT || /\*\*|```/.test(title)) return undefined;
  return title;
}
