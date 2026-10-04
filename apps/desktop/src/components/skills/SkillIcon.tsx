import { WandSparkles } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import ponytailLogo from "../../assets/ponytail/logo.svg";
import { cn } from "../../lib/utils";

const builtinLogos: Readonly<Record<string, string>> = { "DietrichGebert/ponytail": ponytailLogo };

export function SkillIcon({ skill, className }: { skill?: Pick<SkillInfo, "builtin" | "source">; className?: string }) {
  const logo = skill?.builtin && skill.source ? builtinLogos[skill.source] : undefined;
  return logo
    ? <img src={logo} alt="" aria-hidden="true" decoding="async" className={cn("shrink-0 object-contain", className)} />
    : <WandSparkles aria-hidden="true" className={className} />;
}
