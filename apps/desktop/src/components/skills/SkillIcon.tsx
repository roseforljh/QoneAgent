import { WandSparkles } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import ponytailLogo from "../../assets/ponytail/logo.svg";
import { cn } from "../../lib/utils";

const builtinLogos: Readonly<Record<string, string>> = { ponytail: ponytailLogo };

export function SkillIcon({ skill, className }: { skill: SkillInfo; className?: string }) {
  const logo = skill.builtin ? builtinLogos[skill.id] : undefined;
  return logo
    ? <img src={logo} alt="" aria-hidden="true" decoding="async" className={cn("shrink-0 object-contain", className)} />
    : <WandSparkles aria-hidden="true" className={className} />;
}
