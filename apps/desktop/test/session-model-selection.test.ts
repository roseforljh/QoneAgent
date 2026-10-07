import { expect, test } from "bun:test";
import { useStore } from "../src/store";

test("new-session model is copied into draft options and stays independent", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "old-session",
      currentWorkspaceId: "workspace",
      selectedModelId: "model-a",
      draftRunOptions: {},
      workspaces: [{ id: "workspace", name: "Workspace", path: ".", createdAt: 1, updatedAt: 1 }],
      send: async () => true,
      refreshWorkspace: () => {},
    });

    useStore.getState().newSessionInWorkspace("workspace");
    expect(useStore.getState().draftRunOptions).toEqual({ modelId: "model-a" });

    useStore.getState().setSelectedModel("model-b");
    useStore.getState().setSelectedModel("model-c", "old-session");
    expect(useStore.getState().draftRunOptions).toEqual({ modelId: "model-b" });
  } finally {
    useStore.setState(previous, true);
  }
});
