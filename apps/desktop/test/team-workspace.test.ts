import { describe, expect, test } from "bun:test";
import { normalizeTeamExecution, teamCommandSchemas } from "@qone/protocol";
import {
  applyMentionSelection,
  detectActiveMention,
  extractMentionsFromText,
  splitMessageByMentions,
} from "../src/lib/team/mentions";
import { setTeamTransport, useTeamStore } from "../src/lib/team/store";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotModelChip } from "../src/components/team/BotModelChip";
import { TeamAvatar, TeamGroupAvatar } from "../src/components/team/TeamAvatar";
import { useStore } from "../src/store";
import { avatarIdOf, clampCropOffset, computeBaseScale, isCustomAvatar, TEAM_AVATAR_IDS } from "../src/lib/team/avatar";
import { instantiatePresetBots } from "../src/lib/team/presets";
import type { TeamBot, TeamCommandInput, TeamMessage, TeamRunCard } from "../src/lib/team/types";

const sampleBots: TeamBot[] = [
  {
    id: "b1",
    name: "小策",
    roleTitle: "团队统筹",
    description: "",
    systemPrompt: "",
    logo: "crown",
    modelId: "",
    capabilities: ["planning"],
    source: "preset",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "b2",
    name: "小维Pro",
    roleTitle: "运维专家",
    description: "",
    systemPrompt: "",
    logo: "terminal",
    modelId: "",
    capabilities: ["ops"],
    source: "custom",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "b3",
    name: "小维",
    roleTitle: "运维",
    description: "",
    systemPrompt: "",
    logo: "terminal",
    modelId: "",
    capabilities: ["ops"],
    source: "preset",
    createdAt: 1,
    updatedAt: 1,
  },
];

describe("team mentions", () => {
  test("detects active @ query and ignores email addresses", () => {
    expect(detectActiveMention("@小", 2)).toEqual({ start: 0, end: 2, query: "小" });
    expect(detectActiveMention("请帮我 @ops", 8)).toEqual({ start: 4, end: 8, query: "ops" });
    expect(detectActiveMention("user@example.com", 12)).toBeNull();
    expect(detectActiveMention("@小策 看看", 6)).toBeNull();
  });

  test("applies mention selection and updates caret", () => {
    const active = detectActiveMention("安排 @小", 5)!;
    const result = applyMentionSelection("安排 @小", active, "小策");
    expect(result).toEqual({ nextText: "安排 @小策 ", nextCaret: 7 });
  });

  test("extracts longest-match mentions and splits text segments cleanly", () => {
    const mentions = extractMentionsFromText(
      "@小维Pro 和 @全体成员 一起检查，再让 @小维 复核",
      sampleBots,
      ["全体成员"],
    );
    expect(mentions.map((m) => `${m.kind}:${m.targetId}`)).toEqual([
      "bot:b2",
      "all:all",
      "bot:b3",
    ]);

    const segments = splitMessageByMentions("@小维Pro 检查 @全体成员", mentions);
    expect(segments.map((s) => `${s.kind}:${s.value}`)).toEqual([
      "mention:@小维Pro",
      "text: 检查 ",
      "mention:@全体成员",
    ]);
  });
});

describe("team avatars and models", () => {
  test("legacy avatars resolve to local bot faces and presets stay distinct", () => {
    const legacy = { id: "bot-1", avatar: "qone-123-1" };
    const id = avatarIdOf(legacy);
    expect(id).toBe("cloud");
    expect(avatarIdOf({ id: "another-bot", avatar: legacy.avatar })).toBe(id);
    expect(avatarIdOf({ id: "bot-1", avatar: TEAM_AVATAR_IDS[2] })).toBe(TEAM_AVATAR_IDS[2]);
    const presets = instantiatePresetBots((key) => key);
    expect(new Set(presets.map(avatarIdOf)).size).toBe(presets.length);
    expect(avatarIdOf({ ...presets[0], avatar: "noble-count-haughty" })).toBe(avatarIdOf(presets[0]));
    const silhouettes = new Set<string>();
    const monochrome = new Set(["mochi", "panda", "penguin", "helmet"]);
    for (const avatar of TEAM_AVATAR_IDS) {
      const markup = renderToStaticMarkup(createElement(TeamAvatar, { bot: { ...legacy, avatar, name: "小策" }, size: 32 }));
      expect(markup).toContain('aria-label="小策"');
      expect(markup.match(/<rect\b/g)).toHaveLength(2);
      const outline = markup.match(/<path d="([^"]+)"/)?.[1];
      expect(outline).toBeDefined();
      silhouettes.add(outline!);
      if (monochrome.delete(avatar)) {
        expect(avatarIdOf({ ...legacy, avatar })).toBe(avatar);
        expect(markup).toContain('fill="#FFFFFF"');
        expect(markup).toMatch(/fill="#(?:202020|171717)"/);
        expect(markup).toContain("stroke-width=");
      }
    }
    expect(silhouettes.size).toBe(TEAM_AVATAR_IDS.length);
    expect(monochrome.size).toBe(0);
  });

  test("model chips render only for usable, explicit models", () => {
    const state = useStore.getInitialState();
    const previous = state.modelConfigs;
    const config = { id: "p/m", provider: "p", model: "m", config: { displayName: "My Model" }, enabled: true, updatedAt: 0 };
    const render = (modelId: string) => renderToStaticMarkup(createElement(BotModelChip, { bot: { modelId }, onClick() {} }));
    try {
      state.modelConfigs = [config, { ...config, id: "p/off", enabled: false }];
      expect(render("p/m")).toContain("My Model");
      expect(render("")).toBe("");
      expect(render("p/off")).toBe("");
      expect(render("gone")).toBe("");
    } finally {
      state.modelConfigs = previous;
    }
  });

  test("supports custom image avatars with safe protocol validation and bounded crop math", () => {
    const dataUrl = "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
    expect(isCustomAvatar(dataUrl)).toBe(true);
    expect(isCustomAvatar("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
    expect(isCustomAvatar("javascript:alert(1)")).toBe(false);

    const html = renderToStaticMarkup(createElement(TeamAvatar, { bot: { id: "custom-1", avatar: dataUrl, name: "小花" }, size: 48 }));
    expect(html).toContain("<img");
    expect(html).toContain(`src="${dataUrl}"`);
    expect(html).toContain("is-custom");

    const ok = teamCommandSchemas["team.bot.save"].safeParse({
      type: "team.bot.save", requestId: "req-1", bot: { ...sampleBots[0], avatar: dataUrl },
    });
    expect(ok.success).toBe(true);
    const rejectedSvg = teamCommandSchemas["team.bot.save"].safeParse({
      type: "team.bot.save", requestId: "req-2", bot: { ...sampleBots[0], avatar: `data:image/svg+xml;base64,${"A".repeat(100)}` },
    });
    expect(rejectedSvg.success).toBe(false);

    // 800x400 横图放入 260x260 裁剪框：基础缩放到 520x260，1x 时横向最多拖动 130px，纵向为 0。
    expect(computeBaseScale(800, 400, 260)).toBeCloseTo(260 / 400);
    expect(clampCropOffset({ x: 300, y: 50 }, 800, 400, 260, 1)).toEqual({ x: 130, y: 0 });
    expect(clampCropOffset({ x: -999, y: 999 }, 800, 400, 260, 2)).toEqual({ x: -390, y: 130 });

    // 群自定义头像支持自定义 Data URL，清空或未设置时回退到成员头像堆叠。
    const groupCustomHtml = renderToStaticMarkup(createElement(TeamGroupAvatar, { group: { name: "运维组", avatar: dataUrl }, members: sampleBots }));
    expect(groupCustomHtml).toContain("<img");
    expect(groupCustomHtml).toContain(`src="${dataUrl}"`);
    const groupDefaultHtml = renderToStaticMarkup(createElement(TeamGroupAvatar, { group: { name: "运维组" }, members: sampleBots }));
    expect(groupDefaultHtml).toContain("team-avatar-stack");
    const groupPatchOk = teamCommandSchemas["team.group.update"].safeParse({
      type: "team.group.update", requestId: "req-3", groupId: "g1", patch: { avatar: dataUrl },
    });
    expect(groupPatchOk.success).toBe(true);
    const groupResetOk = teamCommandSchemas["team.group.update"].safeParse({
      type: "team.group.update", requestId: "req-4", groupId: "g1", patch: { avatar: "" },
    });
    expect(groupResetOk.success).toBe(true);

    // 任意位置（含紧跟中文后）输入 @ 可触发提及，同时依然忽略邮箱地址。
    expect(detectActiveMention("帮我看下@小", 6)).toEqual({ start: 4, end: 6, query: "小" });
    expect(detectActiveMention("foo@bar", 7)).toBeNull();
    expect(extractMentionsFromText("帮我看下@小策 和 foo@bar", sampleBots, ["全体成员"])).toEqual([
      { kind: "bot", targetId: "b1", label: "小策" },
    ]);

    // 团队消息支持仅带附件发送，同时遵守附件协议校验。
    const attachSend = teamCommandSchemas["team.message.send"].safeParse({
      type: "team.message.send",
      requestId: "req-5",
      groupId: "g1",
      messageId: "m-attach",
      content: "",
      mentions: [],
      attachments: [{ type: "file", name: "spec.md", mimeType: "text/markdown", data: "", localPath: "C:/work/spec.md" }],
    });
    expect(attachSend.success).toBe(true);
  });
});

describe("team execution & store", () => {
  test("keeps local fallback when no servers are bound", () => {
    expect(normalizeTeamExecution({ allowLocal: false, serverIds: [], strategy: "servers-preferred" }))
      .toEqual({ allowLocal: true, serverIds: [], strategy: "smart" });
    expect(normalizeTeamExecution({ allowLocal: true, serverIds: ["srv-1", "srv-1", "srv-2"], strategy: "smart" }))
      .toEqual({ allowLocal: true, serverIds: ["srv-1", "srv-2"], strategy: "smart" });
  });

  const emptyState = { bots: [], groups: [], messages: [], runs: [], presence: {} };
  const reset = () => {
    const sent: TeamCommandInput[] = [];
    setTeamTransport({ send: (command) => { sent.push(command as TeamCommandInput); return true; } });
    useTeamStore.setState({ loaded: false, bots: [], groups: [], activeGroupId: undefined, messagesByGroup: {}, runsByGroup: {}, presenceByGroup: {} });
    return sent;
  };

  test("every write goes to the runtime and the store only mirrors its events", () => {
    const sent = reset();
    useTeamStore.getState().dispatchRuntimeEvent({ type: "team.state", state: emptyState });
    expect(useTeamStore.getState().loaded).toBe(true);
    useTeamStore.getState().ensurePresets((key) => key);
    const presets = sent.filter((command) => command.type === "team.bot.save");
    expect(presets.length).toBeGreaterThan(0);

    const custom = useTeamStore.getState().createBot({
      name: " 巡检官 ", roleTitle: "SRE", description: "检查服务", systemPrompt: "check services", logo: "shield", modelId: "", capabilities: ["ops", "ops"],
    });
    expect(custom.name).toBe("巡检官");
    expect(custom.capabilities).toEqual(["ops"]);
    const coordinator = useTeamStore.getState().bots[0];
    const group = useTeamStore.getState().createGroup({
      name: "生产运维群", description: "测试群", memberBotIds: [coordinator.id, custom.id, custom.id], coordinatorBotId: "missing",
      execution: { allowLocal: false, serverIds: [], strategy: "servers-preferred" },
    });
    expect(group.memberBotIds).toEqual([coordinator.id, custom.id]);
    expect(group.coordinatorBotId).toBe(coordinator.id);
    expect(group.execution).toEqual({ allowLocal: true, serverIds: [], strategy: "smart" });
    expect(sent.at(-1)).toEqual({ type: "team.group.create", group });

    const message = useTeamStore.getState().sendMessage({
      groupId: group.id, content: " @巡检官 查一下磁盘 ", mentions: [{ kind: "bot", targetId: custom.id, label: custom.name }],
      defaults: { model: "p/m", permissionMode: "auto", workspaceId: "ws" },
    })!;
    expect(sent.at(-1)).toEqual({
      type: "team.message.send", groupId: group.id, messageId: message.id, content: "@巡检官 查一下磁盘",
      mentions: [{ kind: "bot", targetId: custom.id, label: custom.name }], mode: "execute",
      defaults: { model: "p/m", permissionMode: "auto", workspaceId: "ws" },
    });

    useTeamStore.getState().updateRunAction("run-1", "confirm_plan");
    expect(sent.at(-1)).toEqual({ type: "team.run.action", runId: "run-1", action: "confirm_plan" });
    useTeamStore.getState().resolveApproval("approval-1", false);
    expect(sent.at(-1)).toEqual({ type: "tool.reject", approvalId: "approval-1" });
  });

  test("merges streamed replies, run cards and presence by id", () => {
    reset();
    useTeamStore.getState().dispatchRuntimeEvent({ type: "team.state", state: emptyState });
    const reply: TeamMessage = { id: "m1", groupId: "g1", senderKind: "bot", senderBotId: "b1", content: "", mentions: [], streaming: true, createdAt: 1 };
    const store = useTeamStore.getState();
    store.dispatchRuntimeEvent({ type: "team.message.append", message: reply });
    store.dispatchRuntimeEvent({ type: "team.message.delta", groupId: "g1", messageId: "m1", delta: "磁盘" });
    store.dispatchRuntimeEvent({ type: "team.message.delta", groupId: "g1", messageId: "m1", delta: "正常" });
    expect(useTeamStore.getState().messagesByGroup.g1).toEqual([{ ...reply, content: "磁盘正常" }]);
    store.dispatchRuntimeEvent({ type: "team.message.append", message: { ...reply, content: "磁盘正常。", streaming: false } });
    expect(useTeamStore.getState().messagesByGroup.g1).toHaveLength(1);
    expect(useTeamStore.getState().messagesByGroup.g1[0].streaming).toBe(false);

    const run: TeamRunCard = {
      id: "r1", groupId: "g1", triggerMessageId: "u1", title: "t", coordinatorBotId: "b1", status: "running", mode: "execute",
      strategy: "smart", targetServerIds: [], allowLocal: true, steps: [], startedAt: 1, updatedAt: 1,
    };
    store.dispatchRuntimeEvent({ type: "team.run.upsert", run });
    store.dispatchRuntimeEvent({ type: "team.run.upsert", run: { ...run, status: "paused" } });
    expect(useTeamStore.getState().runsByGroup.g1.map((item) => item.status)).toEqual(["paused"]);
    store.dispatchRuntimeEvent({ type: "team.bot.presence", groupId: "g1", botId: "b1", presence: "waiting" });
    expect(useTeamStore.getState().presenceByGroup.g1.b1).toBe("waiting");
  });

  test("an empty backend imports the legacy local workspace once", () => {
    const sent = reset();
    const values = new Map<string, string>();
    const localStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
    const previous = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = { localStorage };
    try {
      values.set("qone-team-workspace-v1", JSON.stringify({ state: { bots: sampleBots, groups: [], messagesByGroup: {}, runsByGroup: {} } }));
      useTeamStore.getState().dispatchRuntimeEvent({ type: "team.state", state: emptyState });
      expect(sent).toEqual([{ type: "team.state.import", state: { bots: sampleBots, groups: [], messages: [], runs: [] } }]);
      expect(values.has("qone-team-workspace-v1")).toBe(false);
      expect(useTeamStore.getState().loaded).toBe(false);
      useTeamStore.getState().dispatchRuntimeEvent({ type: "team.state", state: { ...emptyState, bots: sampleBots } });
      expect(useTeamStore.getState().loaded).toBe(true);
      expect(sent).toHaveLength(1);
    } finally {
      (globalThis as { window?: unknown }).window = previous;
    }
  });
});
