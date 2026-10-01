/** Model-authored execution headings travel through the ordinary tool history. */
export const ACTIVITY_TITLE_TOOL = "qone_set_activity_title";
export const ACTIVITY_TITLE_MAX_LENGTH = 120;

export function activityTitleFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (!Object.hasOwn(args, "title")) return undefined;
  const value = (args as Record<string, unknown>).title;
  if (typeof value !== "string") return undefined;
  const title = value.replace(/\s+/gu, " ").trim();
  return title && title.length <= ACTIVITY_TITLE_MAX_LENGTH ? title : undefined;
}
