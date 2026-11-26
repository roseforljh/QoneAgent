import { describe, expect, test } from "bun:test";
import type { ServerInfo } from "@qone/protocol";
import {
  applyMentionSelection,
  detectActiveMention,
  extractMentionsFromText,
  splitMessageByMentions,
} from "../src/lib/team/mentions";
import { normalizeExecutionConfig, useTeamStore } from "../src/lib/team/store";
import type { TeamBot } from "../src/lib/team/types";

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

describe("team execution & store", () => {
  test("keeps local fallback when no servers are bound", () => {
    expect(
      normalizeExecutionConfig({
        allowLocal: false,
        serverIds: [],
        strategy: "servers-preferred",
      }),
    ).toEqual({
      allowLocal: true,
      serverIds: [],
      strategy: "smart",
    });

    expect(
      normalizeExecutionConfig({
        allowLocal: true,
        serverIds: ["srv-1", "srv-1", "srv-2"],
        strategy: "smart",
      }),
    ).toEqual({
      allowLocal: true,
      serverIds: ["srv-1", "srv-2"],
      strategy: "smart",
    });
  });

  test("creates bots/groups, dispatches run cards, and handles run actions", () => {
    useTeamStore.setState({
      initialized: false,
      bots: [],
      groups: [],
      activeGroupId: undefined,
      messagesByGroup: {},
      runsByGroup: {},
      presenceByGroup: {},
    });

    useTeamStore.getState().ensureInitialized((key) => key);
    const custom = useTeamStore.getState().createBot({
      name: "巡检官",
      roleTitle: "SRE",
      description: "检查服务",
      systemPrompt: "check services",
      logo: "shield",
      modelId: "",
      capabilities: ["ops"],
    });

    const group = useTeamStore.getState().createGroup({
      name: "生产运维群",
      description: "测试群",
      memberBotIds: [useTeamStore.getState().bots[0].id, custom.id],
      coordinatorBotId: useTeamStore.getState().bots[0].id,
      execution: { allowLocal: true, serverIds: ["srv-1"], strategy: "smart" },
    });

    const servers: ServerInfo[] = [
      {
        id: "srv-1",
        name: "prod-sg-01",
        host: "10.0.0.1",
        port: 22,
        username: "root",
        auth: { kind: "agent" },
        status: "ready",
        createdAt: 1,
      },
    ];

    const sent = useTeamStore.getState().sendMessage({
      groupId: group.id,
      content: "@巡检官 查一下磁盘和容器",
      mentions: [{ kind: "bot", targetId: custom.id, label: custom.name }],
      servers,
      labels: {
        localTarget: "本机",
        smartTarget: "智能调度",
        coordinateStep: (name) => `${name} 统筹`,
        mentionStep: (name) => `${name} 响应`,
        awaitingNote: "待接入",
      },
    });

    expect(sent).not.toBeNull();
    const runs = useTeamStore.getState().runsByGroup[group.id] ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0].steps[0].botId).toBe(custom.id);
    expect(runs[0].steps[0].targetKind).toBe("auto");

    useTeamStore.getState().updateRunAction(group.id, runs[0].id, "pause");
    expect(useTeamStore.getState().runsByGroup[group.id][0].status).toBe("paused");

    useTeamStore.getState().updateRunAction(group.id, runs[0].id, "cancel");
    expect(useTeamStore.getState().runsByGroup[group.id][0].status).toBe("cancelled");
  });
});
