import { expect, test } from "bun:test";
import type { SkillInfo } from "@qone/protocol";
import { groupSkills, skillGroupRepresentative } from "../src/lib/skill-groups";

const skill = (id: string, overrides: Partial<SkillInfo> = {}): SkillInfo => ({
  id, name: id, description: id, path: `C:/Qone/${id}/SKILL.md`, ...overrides,
});

test("groups built-in repository skills into one package while keeping user skills separate", () => {
  const skills = [
    skill("ponytail", { builtin: true, source: "DietrichGebert/ponytail" }),
    skill("ponytail-review", { builtin: true, source: "DietrichGebert/ponytail" }),
    skill("custom"),
  ];
  const groups = groupSkills(skills);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({ id: "skill-package:DietrichGebert/ponytail", name: "ponytail", packaged: true });
  expect(groups[0]!.skills.map((item) => item.name)).toEqual(["ponytail", "ponytail-review"]);
  expect(skillGroupRepresentative(groups[0]!)!.name).toBe("ponytail");
  expect(groups[1]).toMatchObject({ id: "skill:custom", name: "custom", packaged: false });
});

test("a disabled built-in remains in its package for settings management", () => {
  const groups = groupSkills([
    skill("ponytail", { builtin: true, enabled: false, source: "DietrichGebert/ponytail" }),
    skill("ponytail-help", { builtin: true, enabled: true, source: "DietrichGebert/ponytail" }),
  ]);
  expect(groups[0]!.skills).toHaveLength(2);
  expect(groups[0]!.skills[0]!.enabled).toBe(false);
});
