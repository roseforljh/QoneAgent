import ponytail from "./ponytail.json";
import ponytailReview from "./ponytail-review.json";
import ponytailAudit from "./ponytail-audit.json";
import ponytailDebt from "./ponytail-debt.json";
import ponytailGain from "./ponytail-gain.json";
import ponytailHelp from "./ponytail-help.json";
import { runtimeError } from "../runtime-localization.js";

// Product metadata, independent of the user-editable installation directory.
export const builtinSkillBundles = [ponytail, ponytailReview, ponytailAudit, ponytailDebt, ponytailGain, ponytailHelp];

export function isBuiltinSkillName(name: string): boolean {
  return builtinSkillBundles.some((skill) => skill.id === name.toLowerCase());
}

export function assertUserSkillName(name: string): void {
  if (isBuiltinSkillName(name)) throw runtimeError("skills.builtin.reserved", { name });
}
