import { useState } from "react";
import { WandSparkles } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import ponytailLogo from "../../assets/ponytail/logo.svg";
import { cn } from "../../lib/utils";

const builtinLogos: Readonly<Record<string, string>> = { "DietrichGebert/ponytail": ponytailLogo };
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HOSTNAME = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

/**
 * Publisher icon for a catalog source. Skills publish no per-skill icon (checked
 * across the top sources), so the honest shared identity is who published it.
 * `owner/repo` uses that account's avatar; a bare domain uses its favicon.
 */
export function skillPublisherIcon(source: string | undefined): string | undefined {
  const value = source?.trim();
  if (!value) return undefined;
  if (REPOSITORY.test(value) && !value.split("/").some((part) => part === "." || part === "..")) {
    return `https://github.com/${encodeURIComponent(value.split("/")[0]!)}.png?size=64`;
  }
  if (HOSTNAME.test(value)) return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(value)}.ico`;
  return undefined;
}

type SkillIdentity = Pick<SkillInfo, "builtin" | "source"> & { name?: string };

export function SkillIcon({ skill, className }: { skill?: SkillIdentity; className?: string }) {
  const [failed, setFailed] = useState(false);
  const builtin = skill?.builtin && skill.source ? builtinLogos[skill.source] : undefined;
  const remote = builtin ? undefined : skillPublisherIcon(skill?.source);
  const logo = builtin ?? (failed ? undefined : remote);
  if (logo) return <img src={logo} alt="" aria-hidden="true" decoding="async" loading="lazy" onError={() => setFailed(true)} className={cn("shrink-0 object-contain", className)} />;
  // A publisher-less local skill still needs to be distinguishable from its siblings.
  const initial = skill?.name?.trim().charAt(0).toUpperCase();
  return initial
    ? <span aria-hidden="true" className={cn("grid shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-[0.7em] font-medium text-foreground/60", className)}>{initial}</span>
    : <WandSparkles aria-hidden="true" className={className} />;
}