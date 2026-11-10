import { expect, test } from "bun:test";
import { useStore } from "../src/store";
import { loadNewSessionRunOptions, saveNewSessionRunOptions } from "../src/lib/run-options";

function mockStorage() {
  const storage = new Map<string, string>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  } });
  return { storage, restore: () => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  } };
}

test("new-session configuration persists model, thinking and permission across conversation changes", () => {
  const previous = useStore.getState();
  const { restore } = mockStorage();
  try {
    useStore.setState({
      currentSessionId: undefined,
      currentWorkspaceId: "workspace",
      selectedModelId: undefined,
      draftRunOptions: { permissionMode: "ask" },
      runOptionsBySession: {},
      sessions: [{ id: "old-session", title: "Old", workspaceId: "workspace", createdAt: 1, updatedAt: 1 }],
      workspaces: [{ id: "workspace", name: "Workspace", path: ".", createdAt: 1 }],
      send: async () => true,
      refreshWorkspace: () => {},
    });

    useStore.getState().setSelectedModel("model-a");
    useStore.getState().setRunThinking("model-a", "high");
    useStore.getState().setRunPermissionMode("auto");
    expect(loadNewSessionRunOptions()).toEqual({ modelId: "model-a", permissionMode: "auto", thinkingByModel: { "model-a": "high" } });

    useStore.getState().selectSession("old-session");
    expect(useStore.getState().selectedModelId).toBe("model-a");
    expect(useStore.getState().runOptionsBySession["old-session"]).toEqual({ modelId: "model-a", permissionMode: "auto", thinkingByModel: { "model-a": "high" } });

    useStore.getState().setSelectedModel("model-c");
    useStore.getState().setRunThinking("model-c", "low");
    useStore.getState().setRunPermissionMode("full");
    expect(loadNewSessionRunOptions()).toEqual({ modelId: "model-a", permissionMode: "auto", thinkingByModel: { "model-a": "high" } });

    useStore.getState().newSessionInWorkspace("workspace");
    expect(useStore.getState().selectedModelId).toBe("model-a");
    expect(useStore.getState().draftRunOptions).toEqual({ modelId: "model-a", permissionMode: "auto", thinkingByModel: { "model-a": "high" } });
    expect(useStore.getState().runOptionsBySession["old-session"]).toEqual({ modelId: "model-c", permissionMode: "full", thinkingByModel: { "model-a": "high", "model-c": "low" } });

    useStore.getState().setSelectedModel("model-b");
    useStore.getState().setRunThinking("model-b", "max");
    useStore.getState().selectSession("old-session");
    expect(useStore.getState().selectedModelId).toBe("model-c");
    expect(useStore.getState().runOptionsBySession["old-session"]).toEqual({ modelId: "model-c", permissionMode: "full", thinkingByModel: { "model-a": "high", "model-c": "low" } });
  } finally {
    useStore.setState(previous, true);
    restore();
  }
});

test("new-session defaults migrate legacy model and permission keys", () => {
  const { storage, restore } = mockStorage();
  try {
    storage.set("qone-new-session-model", "legacy-model");
    storage.set("qone-default-permission-mode", "full");
    expect(loadNewSessionRunOptions()).toEqual({ modelId: "legacy-model", permissionMode: "full" });

    saveNewSessionRunOptions({ modelId: "new-model", permissionMode: "auto", thinkingByModel: { "new-model": "medium" } });
    expect(loadNewSessionRunOptions()).toEqual({ modelId: "new-model", permissionMode: "auto", thinkingByModel: { "new-model": "medium" } });
  } finally {
    restore();
  }
});
