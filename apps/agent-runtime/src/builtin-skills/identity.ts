import ponytail from "./ponytail.json";
import { runtimeError } from "../runtime-localization.js";

// Product metadata, independent of the user-editable installation directory.
export const builtinSkillBundles = [ponytail];

export function isBuiltinSkillName(name: string): boolean {
  return builtinSkillBundles.some((skill) => skill.id === name.toLowerCase());
}

export function assertUserSkillName(name: string): void {
  if (isBuiltinSkillName(name)) throw runtimeError("skills.builtin.reserved", { name });
}
