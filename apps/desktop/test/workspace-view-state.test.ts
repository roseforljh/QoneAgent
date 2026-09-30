import { beforeEach, describe, expect, test } from "bun:test";
import {
  _resetWorkspaceViewInternalsForTest,
  clearTrackedWorkspaceRequests,
  dispatchFileRead,
  dispatchWorkspaceError,
  dispatchWorkspaceFiles,
  dispatchWorkspaceGit,
  dispatchWorkspaceGitDiff,
  initWorkspaceView,
  normalizePath,
  removeWorkspaceView,
  requestWorkspaceFileRead,
  requestWorkspaceFiles,
  requestWorkspaceGit,
  requestWorkspaceGitDiff,
  useWorkspaceViewStore,
} from "../src/lib/workspace-view-state";
import type { WorkspaceFileInfo } from "@qone/protocol";

describe("workspace-view-state robustness & ownership", () => {
  beforeEach(() => {
    _resetWorkspaceViewInternalsForTest();
  });

  test("Windows 路径分隔符正规化 normalizePath", () => {
    expect(normalizePath("src\\components\\view.tsx")).toBe("src/components/view.tsx");
    expect(normalizePath("\\root\\path\\")).toBe("root/path");
    expect(normalizePath("")).toBe("");
    expect(normalizePath(undefined)).toBe("");
  });

  test("多 directory 并行请求：每个目录独立 generation，都能正常合并进文件树", async () => {
    const tabId = "tab-files-tree";
    initWorkspaceView(tabId, "ws-1");

    // 并行请求：根目录、src 目录、docs 目录
    const reqRoot = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "",
    });
    const reqSrc = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src",
    });
    const reqDocs = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "docs",
    });

    // 乱序回包：docs 先回包，接着 root 回包，最后 src 回包
    const docsFiles: WorkspaceFileInfo[] = [
      { path: "docs/readme.md", kind: "file", size: 100 },
    ];
    dispatchWorkspaceFiles(
      { type: "workspace.files", requestId: reqDocs, workspaceId: "ws-1", path: "docs", files: docsFiles },
      "ws-1"
    );

    const rootFiles: WorkspaceFileInfo[] = [
      { path: "package.json", kind: "file", size: 200 },
      { path: "src", kind: "directory" },
      { path: "docs", kind: "directory" },
    ];
    // root 回包 (按规则：如果先有了子目录，root 刷新会包含 direct root 文件)
    dispatchWorkspaceFiles(
      { type: "workspace.files", requestId: reqRoot, workspaceId: "ws-1", path: "", files: rootFiles },
      "ws-1"
    );

    const srcFiles: WorkspaceFileInfo[] = [
      { path: "src/index.ts", kind: "file", size: 300 },
    ];
    dispatchWorkspaceFiles(
      { type: "workspace.files", requestId: reqSrc, workspaceId: "ws-1", path: "src", files: srcFiles },
      "ws-1"
    );

    const files = useWorkspaceViewStore.getState().views[tabId]?.files ?? [];
    const paths = files.map((f) => f.path);
    expect(paths).toContain("package.json");
    expect(paths).toContain("src/index.ts");
    expect(useWorkspaceViewStore.getState().views[tabId]?.filesLoading).toBe(false);
  });

  test("同 directory 乱序：旧 generation 晚回包不覆盖新结果", async () => {
    const tabId = "tab-files-dir-race";
    initWorkspaceView(tabId, "ws-1");

    const reqSrc1 = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src",
    });
    const reqSrc2 = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src",
    });

    // reqSrc2 先回包
    const filesV2: WorkspaceFileInfo[] = [
      { path: "src/new.ts", kind: "file", size: 50 },
    ];
    dispatchWorkspaceFiles(
      { type: "workspace.files", requestId: reqSrc2, workspaceId: "ws-1", path: "src", files: filesV2 },
      "ws-1"
    );
    expect(useWorkspaceViewStore.getState().views[tabId]?.files.map((f) => f.path)).toContain("src/new.ts");

    // reqSrc1 慢回包
    const filesV1: WorkspaceFileInfo[] = [
      { path: "src/old.ts", kind: "file", size: 40 },
    ];
    dispatchWorkspaceFiles(
      { type: "workspace.files", requestId: reqSrc1, workspaceId: "ws-1", path: "src", files: filesV1 },
      "ws-1"
    );
    // 必须保持为 v2，v1 被 drop
    const currentPaths = useWorkspaceViewStore.getState().views[tabId]?.files.map((f) => f.path) ?? [];
    expect(currentPaths).toContain("src/new.ts");
    expect(currentPaths).not.toContain("src/old.ts");
  });

  test("Old error 晚到不污染已切换的新文件内容与状态", async () => {
    const tabId = "tab-old-error";
    initWorkspaceView(tabId, "ws-1");

    // 用户先点击 fileA，随后点击 fileB
    const reqA = await requestWorkspaceFileRead({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src/a.ts",
    });
    const reqB = await requestWorkspaceFileRead({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src/b.ts",
    });

    // fileB 正常成功返回
    dispatchFileRead(
      {
        type: "file.read",
        requestId: reqB,
        workspaceId: "ws-1",
        path: "src/b.ts",
        content: "content B",
      },
      "ws-1"
    );
    expect(useWorkspaceViewStore.getState().views[tabId]?.openFile?.path).toBe("src/b.ts");
    expect(useWorkspaceViewStore.getState().views[tabId]?.error).toBeUndefined();

    // 随后 fileA 报错到达
    const errResult = dispatchWorkspaceError(reqA, "Cannot read file A", "ws-1");
    expect(errResult.handledByOwner).toBe(true);

    // fileB 依然完好，error 不应该被写入该 tab！
    expect(useWorkspaceViewStore.getState().views[tabId]?.openFile?.path).toBe("src/b.ts");
    expect(useWorkspaceViewStore.getState().views[tabId]?.error).toBeUndefined();
  });

  test("Refresh / resetViewData 提升 Epoch：所有旧请求全部被 drop", async () => {
    const tabId = "tab-epoch-refresh";
    initWorkspaceView(tabId, "ws-1");

    const reqFilesOld = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "",
    });
    const reqReadOld = await requestWorkspaceFileRead({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src/old.ts",
    });

    // 用户在 UI 点击刷新或者重置
    useWorkspaceViewStore.getState().resetViewData(tabId);
    expect(useWorkspaceViewStore.getState().views[tabId]?.files).toHaveLength(0);

    // 旧 epoch 的请求回包到达
    dispatchWorkspaceFiles(
      {
        type: "workspace.files",
        requestId: reqFilesOld,
        workspaceId: "ws-1",
        files: [{ path: "stale.ts", kind: "file", size: 10 }],
      },
      "ws-1"
    );
    dispatchFileRead(
      {
        type: "file.read",
        requestId: reqReadOld,
        workspaceId: "ws-1",
        path: "src/old.ts",
        content: "stale content",
      },
      "ws-1"
    );

    // 旧请求全部不落地
    expect(useWorkspaceViewStore.getState().views[tabId]?.files).toHaveLength(0);
    expect(useWorkspaceViewStore.getState().views[tabId]?.openFile).toBeUndefined();
  });

  test("Back（clearOpenFile / clearGitDiff）后晚回包不重新选中", async () => {
    const tabId = "tab-back-test";
    initWorkspaceView(tabId, "ws-1");

    // 用户点击了某个慢文件
    const reqSlowFile = await requestWorkspaceFileRead({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "large/video.ts",
    });

    // 用户不想等了，点击“返回文件树”
    useWorkspaceViewStore.getState().clearOpenFile(tabId);
    expect(useWorkspaceViewStore.getState().views[tabId]?.selectedFilePath).toBeUndefined();

    // 此时慢回包到达
    dispatchFileRead(
      {
        type: "file.read",
        requestId: reqSlowFile,
        workspaceId: "ws-1",
        path: "large/video.ts",
        content: "huge data",
      },
      "ws-1"
    );

    // 绝不能重新选中
    expect(useWorkspaceViewStore.getState().views[tabId]?.openFile).toBeUndefined();
    expect(useWorkspaceViewStore.getState().views[tabId]?.selectedFilePath).toBeUndefined();

    // 同理测试 gitDiff 的 back
    const reqSlowDiff = await requestWorkspaceGitDiff({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src/large.ts",
    });
    useWorkspaceViewStore.getState().clearGitDiff(tabId);

    dispatchWorkspaceGitDiff(
      {
        type: "workspace.gitDiff",
        requestId: reqSlowDiff,
        workspaceId: "ws-1",
        path: "src/large.ts",
        diff: "big diff",
      },
      "ws-1"
    );
    expect(useWorkspaceViewStore.getState().views[tabId]?.gitDiffView).toBeUndefined();
    expect(useWorkspaceViewStore.getState().views[tabId]?.selectedDiffPath).toBeUndefined();
  });

  test("带 requestId 且 untracked 的回包绝不作为 global 接受（防重复回包污染全局）", async () => {
    const tabId = "tab-owner-finish";
    initWorkspaceView(tabId, "ws-1");

    const reqId = await requestWorkspaceFileRead({
      ownerId: tabId,
      workspaceId: "ws-1",
      path: "src/done.ts",
    });

    // 第一次回包（成功处理并从 activeRequests untrack）
    const firstDispatch = dispatchFileRead(
      {
        type: "file.read",
        requestId: reqId,
        workspaceId: "ws-1",
        path: "src/done.ts",
        content: "done content",
      },
      "ws-1"
    );
    expect(firstDispatch.handledByOwner).toBe(true);
    expect(firstDispatch.shouldUpdateGlobal).toBe(false);

    // 如果由于网络抖动或后端重复发送，相同的 requestId 再次到达
    const repeatDispatch = dispatchFileRead(
      {
        type: "file.read",
        requestId: reqId,
        workspaceId: "ws-1",
        path: "src/done.ts",
        content: "done content again",
      },
      "ws-1"
    );

    // 因为带了 requestId 但已经不在 activeRequests，绝不能当成 global 接受！
    expect(repeatDispatch.shouldUpdateGlobal).toBe(false);
  });

  test("发送失败（send 返回 false）立即清除 tracked 请求并设置错误，不发生内存泄漏", async () => {
    const tabId = "tab-send-fail";
    initWorkspaceView(tabId, "ws-1");

    const reqId = await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
      send: async () => false, // 模拟非 Tauri 或网络拒绝
    });

    // view 中应该标记发送失败错误且 loading 结束
    expect(useWorkspaceViewStore.getState().views[tabId]?.filesLoading).toBe(false);
    expect(useWorkspaceViewStore.getState().views[tabId]?.error).toBe("Failed to send request");

    // 如果之后有虚假响应带着这个 reqId 进来，因为已被 untrack，不会更新 view 也不会更新 global
    const res = dispatchWorkspaceFiles(
      {
        type: "workspace.files",
        requestId: reqId,
        workspaceId: "ws-1",
        files: [],
      },
      "ws-1"
    );
    expect(res.shouldUpdateGlobal).toBe(false);
  });

  test("clearTrackedWorkspaceRequests 清空全部未决请求并终止 loading", async () => {
    const tabId = "tab-runtime-exit";
    initWorkspaceView(tabId, "ws-1");

    await requestWorkspaceFiles({
      ownerId: tabId,
      workspaceId: "ws-1",
    });
    expect(useWorkspaceViewStore.getState().views[tabId]?.filesLoading).toBe(true);

    clearTrackedWorkspaceRequests();

    expect(useWorkspaceViewStore.getState().views[tabId]?.filesLoading).toBe(false);
  });

  test("关闭后重建同一标签时，旧请求不能写入新视图", async () => {
    const tabId = "tab-recreated";
    initWorkspaceView(tabId, "ws-1");
    const oldRequestId = await requestWorkspaceFiles({ ownerId: tabId, workspaceId: "ws-1" });
    removeWorkspaceView(tabId);
    initWorkspaceView(tabId, "ws-1");
    const newRequestId = await requestWorkspaceFiles({ ownerId: tabId, workspaceId: "ws-1" });

    dispatchWorkspaceFiles({ type: "workspace.files", requestId: newRequestId, workspaceId: "ws-1", files: [{ path: "new.txt", kind: "file" }] }, "ws-1");
    const stale = dispatchWorkspaceFiles({ type: "workspace.files", requestId: oldRequestId, workspaceId: "ws-1", files: [{ path: "old.txt", kind: "file" }] }, "ws-1");

    expect(stale.shouldUpdateGlobal).toBe(false);
    expect(useWorkspaceViewStore.getState().views[tabId]?.files.map((file) => file.path)).toEqual(["new.txt"]);
  });
});
