import { ECC_BUILTIN_SUBAGENTS, isRuntimeMessageKey, runtimeMessage, type RuntimeLocale } from "@qone/protocol";
import { builtinSubagentNames } from "../i18n/builtin-subagent-names";

function catalogEntry(profile: { id?: string; name: string }) {
  return profile.id ? ECC_BUILTIN_SUBAGENTS.find((entry) => entry.id === profile.id && entry.name === profile.name) : undefined;
}

export function subagentProfileCopy(profile: { id?: string; name: string; instructions: string; nameKey?: string; instructionsKey?: string }, locale: RuntimeLocale) {
  const catalog = catalogEntry(profile);
  return {
    name: isRuntimeMessageKey(profile.nameKey)
      ? runtimeMessage(locale, profile.nameKey)
      : catalog ? builtinSubagentNames[catalog.name]?.[locale] ?? catalog.name : profile.name,
    instructions: isRuntimeMessageKey(profile.instructionsKey) ? runtimeMessage(locale, profile.instructionsKey) : profile.instructions,
  };
}

/** Keep untouched ECC defaults locale-aware without persisting the translated display label. */
export function subagentProfileNameForSave(profile: { id: string; name: string } | undefined, value: string, locale: RuntimeLocale): string {
  if (!profile) return value;
  const catalog = ECC_BUILTIN_SUBAGENTS.find((entry) => entry.id === profile.id);
  if (!catalog) return value;
  const display = builtinSubagentNames[catalog.name]?.[locale] ?? catalog.name;
  return value === display || value === catalog.name ? catalog.name : value;
}
