import { isRuntimeMessageKey, runtimeMessage, type RuntimeLocale } from "@qone/protocol";

export function subagentProfileCopy(profile: { name: string; instructions: string; nameKey?: string; instructionsKey?: string }, locale: RuntimeLocale) {
  return {
    name: isRuntimeMessageKey(profile.nameKey) ? runtimeMessage(locale, profile.nameKey) : profile.name,
    instructions: isRuntimeMessageKey(profile.instructionsKey) ? runtimeMessage(locale, profile.instructionsKey) : profile.instructions,
  };
}
