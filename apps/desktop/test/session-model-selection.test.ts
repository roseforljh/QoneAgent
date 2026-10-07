import { expect, test } from "bun:test";
import { useStore } from "../src/store";
import { loadNewSessionModel } from "../src/lib/run-options";

test("new-session model has its own persistent selection across conversation changes", () => {
  const previous = useStore.getState();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  } });
  try {
    useStore.setState({
      currentSessionId: undefined,
      currentWorkspaceId: "workspace",
      selectedModelId: undefined,
      newSessionModelId: undefined,
      draftRunOptions: {},
      runOptionsBySession: {},
      sessions: [{ id: "old-session", title: "Old", workspaceId: "workspace", createdAt: 1, updatedAt: 1 }],
      workspaces: [{ id: "workspace", name: "Workspace", path: ".", createdAt: 1 }],
      send: async () => true,
      refreshWorkspace: () => {},
    });

    useStore.getState().setSelectedModel("model-a");
    expect(loadNewSessionModel()).toBe("model-a");

    useStore.getState().selectSession("old-session");
    useStore.getState().setSelectedModel("model-c");
    expect(useStore.getState().selectedModelId).toBe("model-c");
    expect(loadNewSessionModel()).toBe("model-a");
    useStore.getState().newSessionInWorkspace("workspace");
    expect(useStore.getState().selectedModelId).toBe("model-a");
    expect(useStore.getState().draftRunOptions).toEqual({ modelId: "model-a" });

    useStore.getState().setSelectedModel("model-b");
    useStore.getState().setSelectedModel("model-c", "old-session");
    expect(useStore.getState().draftRunOptions).toEqual({ modelId: "model-b" });
    expect(useStore.getState().newSessionModelId).toBe("model-b");
    expect(loadNewSessionModel()).toBe("model-b");

    useStore.getState().selectSession("old-session");
    useStore.getState().setSelectedModel("model-d");
    useStore.getState().newSessionInWorkspace("workspace");
    expect(useStore.getState().selectedModelId).toBe("model-b");
    expect(useStore.getState().runOptionsBySession["old-session"]?.modelId).toBe("model-d");
    expect(loadNewSessionModel()).toBe("model-b");
  } finally {
    useStore.setState(previous, true);
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
