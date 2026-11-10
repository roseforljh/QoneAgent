import { expect, test } from "bun:test";
import { skillPublisherIcon } from "../src/components/skills/SkillIcon";

test("publisher icons resolve from the catalog source", () => {
  expect(skillPublisherIcon("anthropics/skills")).toBe("https://github.com/anthropics.png?size=64");
  expect(skillPublisherIcon("heygen-com/hyperframes")).toBe("https://github.com/heygen-com.png?size=64");
  // A domain publisher has an account-less identity; its favicon is the honest one.
  expect(skillPublisherIcon("skills.volces.com")).toBe("https://icons.duckduckgo.com/ip3/skills.volces.com.ico");
});

test("unknown or unsafe sources never produce a URL", () => {
  for (const source of [undefined, "", "   ", "just-a-name", "../etc/passwd", "owner/../x", "no-tld"]) {
    expect(skillPublisherIcon(source), String(source)).toBeUndefined();
  }
});