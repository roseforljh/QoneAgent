import type { SkillInfo } from "@qone/protocol";

export type SkillGroup = { id: string; name: string; packaged: boolean; skills: SkillInfo[] };

/** Repository metadata identifies a built-in package; individual names stay executable skills. */
export function groupSkills(skills: readonly SkillInfo[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const packaged = Boolean(skill.builtin && skill.source);
    const id = packaged ? `skill-package:${skill.source}` : `skill:${skill.id}`;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: packaged ? skill.source!.split("/").at(-1)! : skill.name, packaged, skills: [] };
      groups.set(id, group);
    }
    group.skills.push(skill);
  }
  return [...groups.values()];
}

export function skillGroupRepresentative(group: SkillGroup): SkillInfo {
  return group.skills.find((skill) => skill.name === group.name) ?? group.skills[0]!;
}
