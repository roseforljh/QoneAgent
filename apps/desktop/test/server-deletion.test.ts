import { expect, test } from "bun:test";
import { commands, emit, storage, useStore } from "./helpers/chat-store-harness";
import { loadNewSessionRunOptions, loadRunOptions, loadWorkspaceServerIds } from "../src/lib/run-options";
import { useServerStore } from "../src/lib/server-state";
import { createDockStateStore } from "../src/lib/dock-state";
import { emptySessionState } from "../src/lib/session-execution-state";
import type { ServerInfo } from "@qone/protocol";

const server: ServerInfo = { id: "keep", name: "Keep", host: "example.test", port: 22, username: "root", status: "ready", auth: { kind: "agent" }, createdAt: 0 };

test("authoritative server inventory removes deleted selections from main, side, draft and persisted defaults", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: "main", draftRunOptions: { serverIds: ["deleted"], permissionMode: "full" },
      runOptionsBySession: { main: { serverIds: ["keep", "deleted"], modelId: "model" }, side: { serverIds: ["deleted"] } },
      workspaceServerIds: { project: ["keep", "deleted"], other: ["deleted"] },
      backgroundSessions: { side: { ...emptySessionState() } },
    });
    emit({ type: "servers.state", servers: [server], groups: [], tunnels: [] });
    const state = useStore.getState();
    expect(state.runOptionsBySession.main).toEqual({ serverIds: ["keep"], modelId: "model" });
    expect(state.runOptionsBySession.side?.serverIds).toEqual([]);
    expect(state.draftRunOptions).toEqual({ serverIds: [], permissionMode: "full" });
    expect(loadRunOptions()).toEqual(state.runOptionsBySession);
    expect(state.workspaceServerIds).toEqual({ project: ["keep"] });
    expect(loadWorkspaceServerIds()).toEqual(state.workspaceServerIds);
    expect(loadNewSessionRunOptions()).toEqual({ permissionMode: "full" });
    expect([...storage.values()].filter(value => value.includes('"deleted"'))).toEqual([]);
    emit({ type: "servers.state", servers: [server], groups: [], tunnels: [] });
    expect(useStore.getState().runOptionsBySession).toBe(state.runOptionsBySession);
  } finally { useStore.setState(previous, true); }
});

test("servers picked for one conversation never become the next conversation's default", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: undefined, currentWorkspaceId: "workspace", draftRunOptions: { permissionMode: "ask" }, runOptionsBySession: {}, workspaceServerIds: {}, sessions: [],
      workspaces: [{ id: "workspace", name: "Workspace", path: ".", createdAt: 1 }] });
    useStore.getState().newSessionInWorkspace("workspace");
    useStore.getState().setServerIds(["keep"]);
    expect(useStore.getState().draftRunOptions.serverIds).toEqual(["keep"]);
    expect(loadNewSessionRunOptions().serverIds).toBeUndefined();
    emit({ type: "session.created", session: { id: "one", title: "One", workspaceId: "workspace", createdAt: 1, updatedAt: 1 } });
    expect(useStore.getState().runOptionsBySession.one?.serverIds).toEqual(["keep"]);
    expect(useStore.getState().draftRunOptions.serverIds).toBeUndefined();
    useStore.getState().setServerIds(["keep"]);
    useStore.getState().newSessionInWorkspace("workspace");
    expect(useStore.getState().draftRunOptions.serverIds).toBeUndefined();
  } finally { useStore.setState(previous, true); }
});

test("only new chats in the bound project get its selected servers, including on the first run", async () => {
  const previous = useStore.getState();
  const previousServers = useServerStore.getState();
  const workspaces = ["bound", "other"].map(id => ({ id, name: id, path: id, createdAt: 1 }));
  const created = (id: string, workspaceId: string) => emit({ type: "session.created", session: { id, workspaceId, title: id, createdAt: 1, updatedAt: 1 } });
  try {
    useStore.setState({ workspaces, workspaceServerIds: {}, currentSessionId: "existing", sessions: [], runOptionsBySession: { existing: { serverIds: [] } } });
    emit({ type: "servers.state", servers: [server, { ...server, id: "second" }], groups: [], tunnels: [] });
    useStore.getState().setWorkspaceServerIds("bound", ["keep", "second", "keep", "missing"]);
    expect(loadWorkspaceServerIds()).toEqual({ bound: ["keep", "second"] });
    expect(useStore.getState().runOptionsBySession.existing?.serverIds).toEqual([]);

    useStore.getState().newSessionInWorkspace("bound");
    expect(useStore.getState().draftRunOptions.serverIds).toEqual(["keep", "second"]);
    const start = commands.length;
    expect(useStore.getState().runAgent("first message")).toBe(true);
    created("new-bound", "bound");
    await Promise.resolve();
    expect(commands.slice(start)).toContainEqual(expect.objectContaining({ type: "agent.run", sessionId: "new-bound", serverIds: ["keep", "second"] }));
    expect(loadRunOptions()["new-bound"]?.serverIds).toEqual(["keep", "second"]);

    useStore.getState().newSessionInWorkspace("bound");
    useStore.getState().setServerIds([]);
    await useStore.getState().createSessionForWorkspace("bound");
    created("opt-out", "bound");
    expect(useStore.getState().runOptionsBySession["opt-out"]?.serverIds).toEqual([]);
    useStore.getState().newSessionInWorkspace("other");
    expect(useStore.getState().draftRunOptions.serverIds).toBeUndefined();
    await useStore.getState().createSessionForWorkspace("bound", { id: "summary", title: "Previous chat" });
    created("resumed", "bound");
    expect(useStore.getState().runOptionsBySession.resumed?.serverIds).toEqual(["keep", "second"]);

    useStore.getState().setWorkspaceServerIds("bound", []);
    useStore.getState().newSessionInWorkspace("bound");
    expect(useStore.getState().draftRunOptions.serverIds).toBeUndefined();
    expect(loadWorkspaceServerIds()).toEqual({});
    expect(loadNewSessionRunOptions().serverIds).toBeUndefined();
  } finally {
    useStore.setState(previous, true);
    useServerStore.setState(previousServers, true);
  }
});

test("deleting a server removes its terminal tabs from every persisted dock scope only", async () => {
  const store = createDockStateStore({ getItem: () => null, setItem: (_key, value) => { saved = value; }, removeItem() {} });
  let saved: unknown;
  store.getState().update("active", {}, scope => ({ ...scope, collapsed: false, activeTabId: "deleted-terminal", openTabs: [
    { id: "local", view: "terminal" }, { id: "deleted-terminal", view: "terminal", serverId: "deleted" }, { id: "keep-terminal", view: "terminal", serverId: "keep" },
  ] }));
  store.getState().update("background", {}, scope => ({ ...scope, activeTabId: "old", openTabs: [{ id: "old", view: "terminal", serverId: "deleted" }] }));
  store.getState().pruneServers(new Set(["keep"]));
  expect(store.getState().scopes.active?.openTabs.map(tab => tab.id)).toEqual(["local", "keep-terminal"]);
  expect(store.getState().scopes.active?.activeTabId).toBe("local");
  expect(store.getState().scopes.background?.openTabs).toEqual([]);
  expect(store.getState().scopes.background?.activeTabId).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain("deleted");
});
