import { expect, test } from "bun:test";
import type { ServerInfo, TeamBot, TeamGroup, TeamMessage, TeamRunCard } from "@qone/protocol";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { TeamApprovalCommandInput, TeamCommandInput } from "../src/lib/team/types";

const bot: TeamBot = {
  id: "b1", name: "小维", roleTitle: "值班", description: "今日值班", systemPrompt: "值班", logo: "robot",
  modelId: "", capabilities: [], source: "custom", createdAt: 1, updatedAt: 1,
};
const peer = { ...bot, id: "b2", roleTitle: "巡检" };
const group: TeamGroup = {
  id: "group-1", name: "运维群", description: "", announcement: "", memberBotIds: [bot.id, peer.id], coordinatorBotId: bot.id,
  mode: "execute", maxAutoRounds: 1, execution: { allowLocal: true, serverIds: [], strategy: "smart" }, createdAt: 1, updatedAt: 1,
};
const messages: TeamMessage[] = [
  { id: "u1", groupId: group.id, senderKind: "user", content: "巡检状态", mentions: [], runCardId: "r1", createdAt: 2 },
  { id: "m1", groupId: group.id, senderKind: "bot", senderBotId: peer.id, content: "巡检正常", mentions: [], createdAt: 3 },
];
const run: TeamRunCard = {
  id: "r1", groupId: group.id, triggerMessageId: "u1", title: "后台运行记录", coordinatorBotId: bot.id, status: "completed",
  mode: "execute", strategy: "smart", targetServerIds: [], allowLocal: true, startedAt: 2, updatedAt: 3,
  steps: [
    { id: "s1", botId: bot.id, targetKind: "local", title: "值班步骤", status: "completed" },
    { id: "s2", botId: peer.id, messageId: "m1", targetKind: "local", title: "巡检步骤", status: "completed", activity: [{ tool: "read", detail: "health.log", outcome: "done" }] },
  ],
};

async function mountTeamPage() {
  const { window: view } = new JSDOM("<!doctype html><html><body><div id='app'></div></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
  view.Element.prototype.getAnimations = () => [];
  view.Element.prototype.scrollIntoView = () => {};
  const copied: string[] = [];
  Object.defineProperty(view.navigator, "clipboard", { value: { writeText: async (value: string) => { copied.push(value); } } });
  view.matchMedia = (media) => Object.assign(new view.EventTarget(), {
    media, matches: false, onchange: null, addListener() {}, removeListener() {},
  });
  const globals = {
    window: view, document: view.document, navigator: view.navigator,
    CSS: { escape: (value: string) => value },
    HTMLElement: view.HTMLElement, HTMLInputElement: view.HTMLInputElement, SVGElement: view.SVGElement,
    Element: view.Element, Node: view.Node, NodeFilter: view.NodeFilter, Event: view.Event, CustomEvent: view.CustomEvent, DOMRect: view.DOMRect,
    MutationObserver: view.MutationObserver, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: view.getComputedStyle.bind(view), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: view.requestAnimationFrame.bind(view), cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const { createRootRoute, createRouter, createMemoryHistory, RouterContextProvider } = await import("@tanstack/react-router");
  const { setTeamTransport, useTeamStore } = await import("../src/lib/team/store");
  const { useServerStore } = await import("../src/lib/server-state");
  const { resolveConfirmation } = await import("../src/lib/confirm-action");
  const { TeamPage } = await import("../src/components/team/TeamPage");
  const initial = useTeamStore.getState();
  const initialServers = useServerStore.getState();
  const sent: (TeamCommandInput | TeamApprovalCommandInput)[] = [];
  const app = document.querySelector("#app")!;
  const root = createRoot(app);
  const click = async (selector: string, label?: RegExp) => {
    const button = [...document.querySelectorAll<HTMLElement>(selector)]
      .find((item) => !label || label.test(item.textContent.trim()) || label.test(item.getAttribute("aria-label") ?? ""));
    if (!button) throw new Error(`Missing button ${selector} ${label ?? ""}`);
    await act(async () => button.click());
    await act(async () => { await new Promise((resolve) => view.requestAnimationFrame(resolve)); });
  };
  const avatar = () => click(".team-message-stream button[aria-haspopup='dialog']", /^小维$/);
  const action = (label: RegExp) => click(".team-member-popover button", label);
  const composer = () => document.querySelector<HTMLTextAreaElement>(".team-composer-box textarea")!;
  const cleanup = async () => {
    await act(async () => root.unmount());
    setTeamTransport(undefined);
    useTeamStore.setState(initial);
    useServerStore.setState(initialServers);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    view.close();
  };
  try {
    setTeamTransport({ send: (command) => { sent.push(command); return true; } });
    useTeamStore.setState({ loaded: false, bots: [bot, peer], groups: [group], activeGroupId: group.id,
      messagesByGroup: { [group.id]: messages }, runsByGroup: { [group.id]: [run] }, presenceByGroup: {},
    });
    const router = createRouter({ routeTree: createRootRoute({ component: TeamPage }), history: createMemoryHistory({ initialEntries: ["/"] }) });
    await router.load();
    await act(async () => root.render(<RouterContextProvider router={router}><TeamPage /></RouterContextProvider>));
    return { app, view, sent, copied, click, avatar, action, composer, useTeamStore, useServerStore, resolveConfirmation, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

test("message bubbles open copy and reply actions with right click or the keyboard", async () => {
  const { app, view, sent, copied, click, composer, cleanup } = await mountTeamPage();
  try {
    expect(app.querySelector(".team-message-stream")?.textContent).not.toMatch(/回复|复制|Reply|Copy/);
    const userBubble = app.querySelector(".team-bubble-user")!;
    await act(async () => userBubble.dispatchEvent(new view.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })));
    expect(document.querySelectorAll("[role='menuitem']")).toHaveLength(2);
    await click("[role='menuitem']", /^(复制|Copy)$/);
    expect(copied).toEqual([messages[0].content]);
    expect(document.querySelector("[role='menu']")).toBeNull();

    const botBubble = app.querySelector<HTMLElement>(".team-bubble-bot")!;
    await act(async () => {
      botBubble.focus();
      botBubble.dispatchEvent(new view.KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
    });
    await click("[role='menuitem']", /^(回复|Reply)$/);
    expect(app.querySelector(".team-composer-box")?.textContent).toContain(messages[1].content);
    expect(document.activeElement).toBe(composer());
    await act(async () => {
      Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value")?.set?.call(composer(), "收到");
      composer().dispatchEvent(new view.Event("input", { bubbles: true }));
    });
    await click(".team-composer-box button[aria-label]", /^(发送|Send)$/);
    expect(sent.at(-1)).toMatchObject({ type: "team.message.send", groupId: group.id, replyToMessageId: messages[1].id, content: "收到" });
  } finally {
    await cleanup();
  }
});

test("avatar card routes exact mentions, opens private chat, embeds per-step cards inside bot bubbles and keeps resizable panes", async () => {
  const { app, view, sent, click, avatar, action, composer, useTeamStore, useServerStore, resolveConfirmation, cleanup } = await mountTeamPage();
  const inspector = () => document.querySelector(".team-inspector")!;
  try {
    // 左右栏均带拖拽分隔条，右侧栏常驻不可闭合且标题栏无关闭按钮，顶栏已移除冗余运行按钮与浮层
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(inspector().querySelector(".team-segmented")).toBeNull();
    expect(inspector().querySelector('button[aria-label="关闭"], button[aria-label="Close"]')).toBeNull();
    expect(document.querySelector(".team-roster-strip")).toBeNull();
    expect(document.querySelector(".team-env-trigger")).toBeNull();
    expect(document.querySelector('[data-slot="team-runs-toggle"]')).toBeNull();
    expect(document.querySelector(".team-runs-popover")).toBeNull();
    expect(document.querySelector('.team-chat-header button[aria-label="群资料与成员"], .team-chat-header button[aria-label="Group details"]')).toBeNull();
    // 顶栏展示当前项目选择器，底栏 + 按钮直接打开选择器（无二级弹窗菜单）
    expect(document.querySelector('[data-slot="team-workspace-trigger"]')).not.toBeNull();
    expect(document.querySelector('.q-composer-tools-trigger')?.getAttribute("aria-haspopup")).toBeNull();

    // 各成员的执行卡片直接嵌在各自机器人回复气泡内部，已完成步骤默认收起，点击可展开查看操作明细
    expect(document.querySelector(".team-message-stream")?.textContent).toContain("巡检正常");
    const stepCard = () => document.querySelector('.team-bubble-bot .team-step-card[data-step-id="s2"]')!;
    const stepHead = () => stepCard().querySelector<HTMLButtonElement>(".team-step-card-head")!;
    expect(stepCard()).not.toBeNull();
    expect(stepHead().getAttribute("aria-expanded")).toBe("false");
    await click('.team-bubble-bot .team-step-card[data-step-id="s2"] .team-step-card-head');
    expect(stepHead().getAttribute("aria-expanded")).toBe("true");
    expect(stepCard().textContent).toContain("health.log");
    await click('.team-bubble-bot .team-step-card[data-step-id="s2"] .team-step-card-head');
    expect(stepHead().getAttribute("aria-expanded")).toBe("false");

    // 当多个成员独立执行时，各自在各自的气泡内部实时展开执行卡片并支持就地审批，开始输出正文总结时自动收起
    await act(async () => {
      useTeamStore.getState().dispatchRuntimeEvent({
        type: "team.message.append",
        message: { id: "m-live", groupId: group.id, senderKind: "bot", senderBotId: bot.id, content: "", mentions: [], streaming: true, createdAt: 4 },
      });
      useTeamStore.getState().dispatchRuntimeEvent({
        type: "team.run.upsert",
        run: {
          ...run,
          status: "running",
          steps: [
            {
              ...run.steps[0],
              kind: "work",
              messageId: "m-live",
              status: "running",
              approval: { approvalId: "a1", toolName: "write" },
              activity: [
                { id: "op-1", tool: "read", detail: "a.ts", outcome: "done" },
                { id: "op-2", tool: "bash", detail: "bun test", outcome: "running" },
              ],
            },
            run.steps[1],
          ],
        },
      });
    });
    const liveCard = () => document.querySelector('.team-bubble-bot .team-step-card[data-step-id="s1"]')!;
    const liveHead = () => liveCard().querySelector<HTMLButtonElement>(".team-step-card-head")!;
    expect(document.querySelectorAll(".team-bubble-bot .team-step-card")).toHaveLength(2);
    expect(liveHead().getAttribute("aria-expanded")).toBe("true");
    expect(liveCard().textContent).toContain("bun test");
    expect(document.querySelectorAll(".team-bubble-bot .team-typing-dots > span")).toHaveLength(3);
    await click('.team-bubble-bot .team-step-card[data-step-id="s1"] button', /^(批准|允许|Approve)$/);
    expect(sent.at(-1)).toEqual({ type: "tool.approve", approvalId: "a1" });

    // 工具执行完毕且该机器人开始输出正文总结时，其气泡内卡片自动收起
    await act(async () => {
      useTeamStore.getState().dispatchRuntimeEvent({
        type: "team.run.upsert",
        run: {
          ...run,
          status: "running",
          steps: [
            {
              ...run.steps[0],
              kind: "work",
              messageId: "m-live",
              status: "running",
              approval: undefined,
              activity: [
                { id: "op-1", tool: "read", detail: "a.ts", outcome: "done" },
                { id: "op-2", tool: "bash", detail: "bun test", outcome: "done" },
              ],
            },
            run.steps[1],
          ],
        },
      });
      useTeamStore.getState().dispatchRuntimeEvent({
        type: "team.message.delta",
        groupId: group.id,
        messageId: "m-live",
        delta: "排查结论如下",
      });
    });
    expect(liveHead().getAttribute("aria-expanded")).toBe("false");

    // 成员头像名片保留私聊、提及成员、编辑参数 3 个动作
    await avatar();
    expect(document.querySelector(".team-member-popover")?.textContent).toContain(peer.roleTitle);
    expect(document.querySelectorAll(".team-member-popover button")).toHaveLength(3);
    await action(/^(提及成员|Mention)$/);
    expect(composer().value).toBe("@小维 ");
    await click(".team-composer-box button[aria-label]", /^(发送|Send)$/);
    expect(sent.at(-1)).toMatchObject({ type: "team.message.send", groupId: group.id, mentions: [{ kind: "bot", targetId: peer.id, label: peer.name }] });

    await avatar();
    await action(/^(提及成员|Mention)$/);
    await avatar();
    await action(/私聊|Direct chat/);
    expect(useTeamStore.getState().groups.find((item) => item.directBotId === peer.id)?.memberBotIds).toEqual([peer.id]);
    expect(composer().value).toBe("");
    expect(app.querySelector(".team-message-stream")?.textContent).not.toContain("巡检正常");
    await click(".team-inspector button[aria-haspopup='dialog']", /^小维$/);
    await action(/编辑参数|Edit settings/);
    expect(document.querySelector('.team-wizard-dialog input:not([type="file"])')?.getAttribute("value")).toBe(peer.name);
    await click(".team-wizard-dialog button[aria-label]", /^(关闭|Close)$/);
    await click(".team-group-item", /运维群/);
    expect(composer().value).toBe("@小维 ");
    await avatar();
    await action(/私聊|Direct chat/);
    expect(sent.filter((command) => command.type === "team.group.create")).toHaveLength(1);

    // 切回群聊后，验证右侧栏最多展示 3 位成员，超出通过弹窗查看全部成员
    await click(".team-group-item", /运维群/);
    const extraBots: TeamBot[] = [
      { ...bot, id: "b3", name: "小码", roleTitle: "开发" },
      { ...bot, id: "b4", name: "小审", roleTitle: "审查" },
    ];
    await act(async () => {
      useTeamStore.setState((state) => ({
        bots: [...state.bots, ...extraBots],
        groups: state.groups.map((item) =>
          item.id === group.id ? { ...item, memberBotIds: [bot.id, peer.id, "b3", "b4"] } : item,
        ),
      }));
    });
    expect(inspector().querySelectorAll('[data-slot="team-inspector-member"]')).toHaveLength(3);
    await click(".team-inspector button", /查看全部成员|View all members/);
    const membersDialog = document.querySelector('[role="dialog"]')!;
    expect(membersDialog.querySelectorAll('[data-slot="team-inspector-member"]')).toHaveLength(4);
    expect(membersDialog.textContent).toContain("小审");
    await click('[role="dialog"] button[aria-label]', /^(关闭|Close)$/);

    // 绑定服务器与成员规则一致：右侧栏最多展示 3 台，超出通过弹窗查看全部服务器
    const mockServers: ServerInfo[] = [1, 2, 3, 4].map((index) => ({
      id: `srv-${index}`,
      name: `Node-${index}`,
      host: `10.0.0.${index}`,
      port: 22,
      username: "root",
      auth: { kind: "agent" },
      status: "ready",
      createdAt: index,
    }));
    await act(async () => {
      useServerStore.setState({ loaded: true, servers: mockServers });
      useTeamStore.setState((state) => ({
        groups: state.groups.map((item) =>
          item.id === group.id
            ? { ...item, execution: { ...item.execution, serverIds: mockServers.map((s) => s.id) } }
            : item,
        ),
      }));
    });
    expect(inspector().querySelectorAll('[data-slot="team-inspector-server"]')).toHaveLength(3);
    await click(".team-inspector button", /查看全部服务器|View all servers/);
    const serversDialog = document.querySelector('[role="dialog"]')!;
    expect(serversDialog.querySelectorAll('[data-slot="team-inspector-server"]')).toHaveLength(4);
    expect(serversDialog.textContent).toContain("Node-4");
    await click('[role="dialog"] button[aria-label]', /^(关闭|Close)$/);

    // 移出群聊必须经过二次确认：取消不移除，确认后才移除
    const memberCountBefore = useTeamStore.getState().groups.find((item) => item.id === group.id)!.memberBotIds.length;
    await click(".team-inspector button", /移出群聊|Remove/);
    await act(async () => resolveConfirmation(false));
    expect(useTeamStore.getState().groups.find((item) => item.id === group.id)!.memberBotIds).toHaveLength(memberCountBefore);
    await click(".team-inspector button", /移出群聊|Remove/);
    await act(async () => resolveConfirmation(true));
    expect(useTeamStore.getState().groups.find((item) => item.id === group.id)!.memberBotIds).toHaveLength(memberCountBefore - 1);

    // 侧边栏支持真实收起与展开，并响应全局切换事件
    const sidebarClip = () => document.querySelector(".q-sidebar-pane .q-sidebar-clip")!;
    expect(document.querySelector(".team-sidebar-head a")).toBeNull();
    expect(sidebarClip().getAttribute("aria-hidden")).toBe("false");
    await click(".team-sidebar-head button", /收起侧边栏|Collapse sidebar/);
    expect(sidebarClip().getAttribute("aria-hidden")).toBe("true");
    await click(".team-chat-header button", /展开侧边栏|Expand sidebar/);
    expect(sidebarClip().getAttribute("aria-hidden")).toBe("false");
    await act(async () => { view.dispatchEvent(new view.Event("qone-toggle-sidebar")); });
    expect(sidebarClip().getAttribute("aria-hidden")).toBe("true");
  } finally {
    await cleanup();
  }
});
