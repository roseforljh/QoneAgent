import { create } from "zustand";
import type { WorkspaceFileInfo, WorkspaceGitEntry, RuntimeCommand, RuntimeEvent } from "@qone/protocol";

export interface WorkspaceViewState {
  ownerId: string;
  workspaceId: string;
  files: WorkspaceFileInfo[];
  filesLoading: boolean;
  openFile?: { path: string; content: string };
  selectedFilePath?: string;
  gitStatus: string;
  gitEntries: WorkspaceGitEntry[];
  gitLoaded: boolean;
  gitDiffView?: { path: string; diff: string; scope?: "staged" | "unstaged" };
  selectedDiffPath?: string;
  error?: string;
}

export function normalizePath(p?: string): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

interface RequestRecord {
  requestId: string;
  type: "workspace.files" | "file.read" | "workspace.git" | "workspace.gitDiff";
  workspaceId: string;
  ownerId?: string;
  epoch: number;
  generation: number;
  path?: string; // normalized
  scope?: "staged" | "unstaged";
}

const activeRequests = new Map<string, RequestRecord>();

interface OwnerGenerations {
  epoch: number;
  dirFiles: Map<string, number>;
  fileRead: number;
  git: number;
  gitDiff: number;
}

const ownerGenerations = new Map<string, OwnerGenerations>();

const globalGenerations: OwnerGenerations = {
  epoch: 0,
  dirFiles: new Map(),
  fileRead: 0,
  git: 0,
  gitDiff: 0,
};

function getOwnerGens(ownerId: string): OwnerGenerations {
  let gens = ownerGenerations.get(ownerId);
  if (!gens) {
    gens = {
      epoch: 0,
      dirFiles: new Map(),
      fileRead: 0,
      git: 0,
      gitDiff: 0,
    };
    ownerGenerations.set(ownerId, gens);
  }
  return gens;
}

export interface WorkspaceViewStore {
  views: Record<string, WorkspaceViewState>;
  initView: (ownerId: string, workspaceId: string) => void;
  removeView: (ownerId: string) => void;
  setWorkspaceId: (ownerId: string, workspaceId: string) => void;
  setSelectedFilePath: (ownerId: string, path?: string) => void;
  setSelectedDiffPath: (ownerId: string, path?: string) => void;
  clearOpenFile: (ownerId: string) => void;
  clearGitDiff: (ownerId: string) => void;
  setError: (ownerId: string, error?: string) => void;
  resetViewData: (ownerId: string) => void;
  bumpEpoch: (ownerId: string) => void;
}

export const useWorkspaceViewStore = create<WorkspaceViewStore>((set) => ({
  views: {},

  initView: (ownerId: string, workspaceId: string) => {
    set((state) => {
      const existing = state.views[ownerId];
      if (existing && existing.workspaceId === workspaceId) return state;
      const gens = getOwnerGens(ownerId);
      gens.epoch++;
      gens.dirFiles.clear();
      gens.fileRead++;
      gens.git++;
      gens.gitDiff++;
      return {
        views: {
          ...state.views,
          [ownerId]: {
            ownerId,
            workspaceId,
            files: [],
            filesLoading: false,
            openFile: undefined,
            selectedFilePath: undefined,
            gitStatus: "",
            gitEntries: [],
            gitLoaded: false,
            gitDiffView: undefined,
            selectedDiffPath: undefined,
            error: undefined,
          },
        },
      };
    });
  },

  removeView: (ownerId: string) => {
    // Keep pending requests owned until their response/error arrives. Otherwise
    // they could be mistaken for global requests, or match a recreated owner.
    const gens = ownerGenerations.get(ownerId);
    if (gens) gens.epoch++;
    if (![...activeRequests.values()].some((request) => request.ownerId === ownerId)) ownerGenerations.delete(ownerId);
    set((state) => {
      if (!state.views[ownerId]) return state;
      const next = { ...state.views };
      delete next[ownerId];
      return { views: next };
    });
  },

  setWorkspaceId: (ownerId: string, workspaceId: string) => {
    set((state) => {
      const existing = state.views[ownerId];
      if (!existing || existing.workspaceId === workspaceId) return state;
      const gens = getOwnerGens(ownerId);
      gens.epoch++;
      gens.dirFiles.clear();
      gens.fileRead++;
      gens.git++;
      gens.gitDiff++;
      return {
        views: {
          ...state.views,
          [ownerId]: {
            ...existing,
            workspaceId,
            files: [],
            filesLoading: false,
            openFile: undefined,
            selectedFilePath: undefined,
            gitStatus: "",
            gitEntries: [],
            gitLoaded: false,
            gitDiffView: undefined,
            selectedDiffPath: undefined,
            error: undefined,
          },
        },
      };
    });
  },

  setSelectedFilePath: (ownerId: string, path?: string) => {
    set((state) => {
      const v = state.views[ownerId];
      if (!v) return state;
      return {
        views: {
          ...state.views,
          [ownerId]: { ...v, selectedFilePath: path ? normalizePath(path) : undefined, error: undefined },
        },
      };
    });
  },

  setSelectedDiffPath: (ownerId: string, path?: string) => {
    set((state) => {
      const v = state.views[ownerId];
      if (!v) return state;
      return {
        views: {
          ...state.views,
          [ownerId]: { ...v, selectedDiffPath: path ? normalizePath(path) : undefined, error: undefined },
        },
      };
    });
  },

  clearOpenFile: (ownerId: string) => {
    const gens = getOwnerGens(ownerId);
    gens.fileRead++; // Invalidate any in-flight file read requests immediately
    set((state) => {
      const v = state.views[ownerId];
      if (!v) return state;
      return {
        views: {
          ...state.views,
          [ownerId]: { ...v, openFile: undefined, selectedFilePath: undefined, error: undefined },
        },
      };
    });
  },

  clearGitDiff: (ownerId: string) => {
    const gens = getOwnerGens(ownerId);
    gens.gitDiff++; // Invalidate any in-flight git diff requests immediately
    set((state) => {
      const v = state.views[ownerId];
      if (!v) return state;
      return {
        views: {
          ...state.views,
          [ownerId]: { ...v, gitDiffView: undefined, selectedDiffPath: undefined, error: undefined },
        },
      };
    });
  },

  setError: (ownerId: string, error?: string) => {
    set((state) => {
      const v = state.views[ownerId];
      if (!v) return state;
      return {
        views: {
          ...state.views,
          [ownerId]: { ...v, filesLoading: false, error },
        },
      };
    });
  },

  resetViewData: (ownerId: string) => {
    const gens = getOwnerGens(ownerId);
    gens.epoch++;
    gens.dirFiles.clear();
    gens.fileRead++;
    gens.git++;
    gens.gitDiff++;
    set((state) => {
      const v = state.views[ownerId];
      if (!v) return state;
      return {
        views: {
          ...state.views,
          [ownerId]: {
            ...v,
            files: [],
            filesLoading: false,
            openFile: undefined,
            selectedFilePath: undefined,
            gitStatus: "",
            gitEntries: [],
            gitLoaded: false,
            gitDiffView: undefined,
            selectedDiffPath: undefined,
            error: undefined,
          },
        },
      };
    });
  },

  bumpEpoch: (ownerId: string) => {
    const gens = getOwnerGens(ownerId);
    gens.epoch++;
    gens.dirFiles.clear();
    gens.fileRead++;
    gens.git++;
    gens.gitDiff++;
  },
}));

export function useWorkspaceViewState(ownerId: string): WorkspaceViewState | undefined {
  return useWorkspaceViewStore((s) => s.views[ownerId]);
}

export function initWorkspaceView(ownerId: string, workspaceId: string): void {
  useWorkspaceViewStore.getState().initView(ownerId, workspaceId);
}

export function removeWorkspaceView(ownerId: string): void {
  useWorkspaceViewStore.getState().removeView(ownerId);
}

export function trackWorkspaceRequest(record: {
  requestId: string;
  type: "workspace.files" | "file.read" | "workspace.git" | "workspace.gitDiff";
  workspaceId: string;
  ownerId?: string;
  path?: string;
  scope?: "staged" | "unstaged";
}): void {
  const normPath = normalizePath(record.path);
  const existing = activeRequests.get(record.requestId);
  if (existing) {
    if (record.ownerId && !existing.ownerId) {
      existing.ownerId = record.ownerId;
    }
    return;
  }

  let generation: number;
  let epoch: number;
  if (record.ownerId) {
    const gens = getOwnerGens(record.ownerId);
    epoch = gens.epoch;
    if (record.type === "workspace.files") {
      const next = (gens.dirFiles.get(normPath) ?? 0) + 1;
      gens.dirFiles.set(normPath, next);
      generation = next;
    } else if (record.type === "file.read") {
      generation = ++gens.fileRead;
    } else if (record.type === "workspace.git") {
      generation = ++gens.git;
    } else {
      generation = ++gens.gitDiff;
    }
  } else {
    epoch = globalGenerations.epoch;
    if (record.type === "workspace.files") {
      const next = (globalGenerations.dirFiles.get(normPath) ?? 0) + 1;
      globalGenerations.dirFiles.set(normPath, next);
      generation = next;
    } else if (record.type === "file.read") {
      generation = ++globalGenerations.fileRead;
    } else if (record.type === "workspace.git") {
      generation = ++globalGenerations.git;
    } else {
      generation = ++globalGenerations.gitDiff;
    }
  }

  activeRequests.set(record.requestId, {
    requestId: record.requestId,
    type: record.type,
    workspaceId: record.workspaceId,
    ownerId: record.ownerId,
    epoch,
    generation,
    path: normPath,
    scope: record.scope,
  });
}

export function getTrackedWorkspaceRequest(requestId: string | undefined): RequestRecord | undefined {
  if (!requestId) return undefined;
  return activeRequests.get(requestId);
}

export function untrackWorkspaceRequest(requestId: string | undefined): RequestRecord | undefined {
  if (!requestId) return undefined;
  const rec = activeRequests.get(requestId);
  activeRequests.delete(requestId);
  if (rec?.ownerId && !useWorkspaceViewStore.getState().views[rec.ownerId] &&
    ![...activeRequests.values()].some((request) => request.ownerId === rec.ownerId)) ownerGenerations.delete(rec.ownerId);
  return rec;
}

export function clearTrackedWorkspaceRequests(): void {
  activeRequests.clear();
  useWorkspaceViewStore.setState((state) => {
    let changed = false;
    const nextViews: Record<string, WorkspaceViewState> = {};
    for (const [id, view] of Object.entries(state.views)) {
      if (view.filesLoading) {
        changed = true;
        nextViews[id] = { ...view, filesLoading: false };
      } else {
        nextViews[id] = view;
      }
    }
    return changed ? { views: nextViews } : state;
  });
}

export interface RequestWorkspaceOptions {
  ownerId?: string;
  workspaceId: string;
  send?: (cmd: RuntimeCommand) => Promise<boolean>;
}

export async function requestWorkspaceFiles(
  options: RequestWorkspaceOptions & { path?: string; requestId?: string }
): Promise<string> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const normPath = normalizePath(options.path);
  trackWorkspaceRequest({
    requestId,
    type: "workspace.files",
    workspaceId: options.workspaceId,
    ownerId: options.ownerId,
    path: normPath,
  });
  if (options.ownerId) {
    useWorkspaceViewStore.setState((state) => {
      const v = state.views[options.ownerId!];
      if (!v) return state;
      return { views: { ...state.views, [options.ownerId!]: { ...v, filesLoading: true, error: undefined } } };
    });
  }
  if (options.send) {
    const cmd: RuntimeCommand = {
      type: "workspace.files",
      requestId,
      workspaceId: options.workspaceId,
      ...(normPath ? { path: normPath } : {}),
    };
    try {
      const sent = await options.send(cmd);
      if (!sent) {
        untrackWorkspaceRequest(requestId);
        if (options.ownerId) {
          useWorkspaceViewStore.getState().setError(options.ownerId, "Failed to send request");
        }
      }
    } catch (err) {
      untrackWorkspaceRequest(requestId);
      if (options.ownerId) {
        useWorkspaceViewStore.getState().setError(options.ownerId, String(err));
      }
    }
  }
  return requestId;
}

export async function requestWorkspaceFileRead(
  options: RequestWorkspaceOptions & { path: string; requestId?: string }
): Promise<string> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const normPath = normalizePath(options.path);
  trackWorkspaceRequest({
    requestId,
    type: "file.read",
    workspaceId: options.workspaceId,
    ownerId: options.ownerId,
    path: normPath,
  });
  if (options.ownerId) {
    useWorkspaceViewStore.setState((state) => {
      const v = state.views[options.ownerId!];
      if (!v) return state;
      return { views: { ...state.views, [options.ownerId!]: { ...v, selectedFilePath: normPath, openFile: undefined, error: undefined } } };
    });
  }
  if (options.send) {
    const cmd: RuntimeCommand = {
      type: "file.read",
      requestId,
      workspaceId: options.workspaceId,
      path: normPath,
    };
    try {
      const sent = await options.send(cmd);
      if (!sent) {
        untrackWorkspaceRequest(requestId);
        if (options.ownerId) {
          useWorkspaceViewStore.getState().setError(options.ownerId, "Failed to send request");
        }
      }
    } catch (err) {
      untrackWorkspaceRequest(requestId);
      if (options.ownerId) {
        useWorkspaceViewStore.getState().setError(options.ownerId, String(err));
      }
    }
  }
  return requestId;
}

export async function requestWorkspaceGit(
  options: RequestWorkspaceOptions & { requestId?: string }
): Promise<string> {
  const requestId = options.requestId ?? crypto.randomUUID();
  trackWorkspaceRequest({
    requestId,
    type: "workspace.git",
    workspaceId: options.workspaceId,
    ownerId: options.ownerId,
  });
  if (options.ownerId) {
    useWorkspaceViewStore.setState((state) => {
      const v = state.views[options.ownerId!];
      if (!v) return state;
      return { views: { ...state.views, [options.ownerId!]: { ...v, gitLoaded: false, error: undefined } } };
    });
  }
  if (options.send) {
    const cmd: RuntimeCommand = {
      type: "workspace.git",
      requestId,
      workspaceId: options.workspaceId,
    };
    try {
      const sent = await options.send(cmd);
      if (!sent) {
        untrackWorkspaceRequest(requestId);
        if (options.ownerId) {
          useWorkspaceViewStore.getState().setError(options.ownerId, "Failed to send request");
        }
      }
    } catch (err) {
      untrackWorkspaceRequest(requestId);
      if (options.ownerId) {
        useWorkspaceViewStore.getState().setError(options.ownerId, String(err));
      }
    }
  }
  return requestId;
}

export async function requestWorkspaceGitDiff(
  options: RequestWorkspaceOptions & { path: string; scope?: "staged" | "unstaged"; requestId?: string }
): Promise<string> {
  const requestId = options.requestId ?? crypto.randomUUID();
  const normPath = normalizePath(options.path);
  trackWorkspaceRequest({
    requestId,
    type: "workspace.gitDiff",
    workspaceId: options.workspaceId,
    ownerId: options.ownerId,
    path: normPath,
    scope: options.scope,
  });
  if (options.ownerId) {
    useWorkspaceViewStore.setState((state) => {
      const v = state.views[options.ownerId!];
      if (!v) return state;
      return { views: { ...state.views, [options.ownerId!]: { ...v, selectedDiffPath: normPath, gitDiffView: undefined, error: undefined } } };
    });
  }
  if (options.send) {
    const cmd: RuntimeCommand = {
      type: "workspace.gitDiff",
      requestId,
      workspaceId: options.workspaceId,
      path: normPath,
      ...(options.scope ? { scope: options.scope } : {}),
    };
    try {
      const sent = await options.send(cmd);
      if (!sent) {
        untrackWorkspaceRequest(requestId);
        if (options.ownerId) {
          useWorkspaceViewStore.getState().setError(options.ownerId, "Failed to send request");
        }
      }
    } catch (err) {
      untrackWorkspaceRequest(requestId);
      if (options.ownerId) {
        useWorkspaceViewStore.getState().setError(options.ownerId, String(err));
      }
    }
  }
  return requestId;
}

export interface DispatchResult {
  handledByOwner: boolean;
  shouldUpdateGlobal: boolean;
}

export function dispatchWorkspaceFiles(
  msg: Extract<RuntimeEvent, { type: "workspace.files" }>,
  currentGlobalWorkspaceId?: string
): DispatchResult {
  const rec = untrackWorkspaceRequest(msg.requestId);
  const normReqPath = normalizePath(msg.path);
  const normalizedIncomingFiles = msg.files.map((file) => ({
    ...file,
    path: normalizePath(file.path),
  }));

  if (rec && rec.ownerId) {
    const ownerId = rec.ownerId;
    const state = useWorkspaceViewStore.getState();
    const view = state.views[ownerId];
    if (!view || view.workspaceId !== msg.workspaceId) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    const gens = getOwnerGens(ownerId);
    if (rec.epoch !== gens.epoch) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    const curGen = gens.dirFiles.get(rec.path || "") ?? 0;
    if (rec.generation < curGen) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    useWorkspaceViewStore.setState((st) => {
      const current = st.views[ownerId];
      if (!current || current.workspaceId !== msg.workspaceId) return st;
      let nextFiles: WorkspaceFileInfo[];
      if (!normReqPath) {
        // Root refresh: replace entirely with direct/incoming files
        nextFiles = normalizedIncomingFiles;
      } else {
        // Nested directory update: replace only entries under normReqPath/
        nextFiles = [
          ...current.files.filter((file) => {
            const p = normalizePath(file.path);
            return !p.startsWith(`${normReqPath}/`);
          }),
          ...normalizedIncomingFiles,
        ];
      }
      return {
        views: {
          ...st.views,
          [ownerId]: {
            ...current,
            files: nextFiles,
            filesLoading: false,
            error: undefined,
          },
        },
      };
    });
    return { handledByOwner: true, shouldUpdateGlobal: false };
  }

  // If requestId exists but is untracked (e.g. repeated response of completed owner request),
  // do NOT let it fallback to global. Only untracked messages WITHOUT requestId are allowed as legacy push.
  if (msg.requestId && !rec) {
    return { handledByOwner: false, shouldUpdateGlobal: false };
  }

  // Global request
  const curGlobalGen = globalGenerations.dirFiles.get(normReqPath) ?? 0;
  const shouldUpdateGlobal =
    msg.workspaceId === currentGlobalWorkspaceId &&
    (!rec || (rec.epoch === globalGenerations.epoch && rec.generation >= curGlobalGen));
  return { handledByOwner: false, shouldUpdateGlobal };
}

export function dispatchFileRead(
  msg: Extract<RuntimeEvent, { type: "file.read" }>,
  currentGlobalWorkspaceId?: string
): DispatchResult {
  const rec = untrackWorkspaceRequest(msg.requestId);
  const normPath = normalizePath(msg.path);
  if (rec && rec.ownerId) {
    const ownerId = rec.ownerId;
    const state = useWorkspaceViewStore.getState();
    const view = state.views[ownerId];
    if (!view || view.workspaceId !== msg.workspaceId) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    const gens = getOwnerGens(ownerId);
    if (rec.epoch !== gens.epoch || rec.generation < gens.fileRead) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    // Also guard that the returned path matches the currently selected file path
    if (view.selectedFilePath && view.selectedFilePath !== normPath) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    useWorkspaceViewStore.setState((st) => {
      const current = st.views[ownerId];
      if (!current || current.workspaceId !== msg.workspaceId) return st;
      return {
        views: {
          ...st.views,
          [ownerId]: {
            ...current,
            openFile: { path: normPath, content: msg.content },
            selectedFilePath: normPath,
            error: undefined,
          },
        },
      };
    });
    return { handledByOwner: true, shouldUpdateGlobal: false };
  }

  // If requestId exists but is untracked, do NOT fallback to global
  if (msg.requestId && !rec) {
    return { handledByOwner: false, shouldUpdateGlobal: false };
  }

  // Global request: must match current global workspace, epoch and latest generation
  const shouldUpdateGlobal =
    msg.workspaceId === currentGlobalWorkspaceId &&
    (!rec || (rec.epoch === globalGenerations.epoch && rec.generation >= globalGenerations.fileRead));
  return { handledByOwner: false, shouldUpdateGlobal };
}

export function dispatchWorkspaceGit(
  msg: Extract<RuntimeEvent, { type: "workspace.git" }>,
  currentGlobalWorkspaceId?: string
): DispatchResult {
  const rec = untrackWorkspaceRequest(msg.requestId);
  if (rec && rec.ownerId) {
    const ownerId = rec.ownerId;
    const state = useWorkspaceViewStore.getState();
    const view = state.views[ownerId];
    if (!view || view.workspaceId !== msg.workspaceId) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    const gens = getOwnerGens(ownerId);
    if (rec.epoch !== gens.epoch || rec.generation < gens.git) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    useWorkspaceViewStore.setState((st) => {
      const current = st.views[ownerId];
      if (!current || current.workspaceId !== msg.workspaceId) return st;
      return {
        views: {
          ...st.views,
          [ownerId]: {
            ...current,
            gitStatus: msg.status,
            gitEntries: (msg.entries ?? []).map((e) => ({ ...e, path: normalizePath(e.path) })),
            gitLoaded: true,
            error: undefined,
          },
        },
      };
    });
    return { handledByOwner: true, shouldUpdateGlobal: false };
  }

  if (msg.requestId && !rec) {
    return { handledByOwner: false, shouldUpdateGlobal: false };
  }

  const shouldUpdateGlobal =
    msg.workspaceId === currentGlobalWorkspaceId &&
    (!rec || (rec.epoch === globalGenerations.epoch && rec.generation >= globalGenerations.git));
  return { handledByOwner: false, shouldUpdateGlobal };
}

export function dispatchWorkspaceGitDiff(
  msg: Extract<RuntimeEvent, { type: "workspace.gitDiff" }>,
  currentGlobalWorkspaceId?: string
): DispatchResult {
  const rec = untrackWorkspaceRequest(msg.requestId);
  const normPath = normalizePath(msg.path);
  if (rec && rec.ownerId) {
    const ownerId = rec.ownerId;
    const state = useWorkspaceViewStore.getState();
    const view = state.views[ownerId];
    if (!view || view.workspaceId !== msg.workspaceId) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    const gens = getOwnerGens(ownerId);
    if (rec.epoch !== gens.epoch || rec.generation < gens.gitDiff) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    if (view.selectedDiffPath && view.selectedDiffPath !== normPath) {
      return { handledByOwner: true, shouldUpdateGlobal: false };
    }
    useWorkspaceViewStore.setState((st) => {
      const current = st.views[ownerId];
      if (!current || current.workspaceId !== msg.workspaceId) return st;
      return {
        views: {
          ...st.views,
          [ownerId]: {
            ...current,
            gitDiffView: { path: normPath, diff: msg.diff, scope: rec.scope },
            selectedDiffPath: normPath,
            error: undefined,
          },
        },
      };
    });
    return { handledByOwner: true, shouldUpdateGlobal: false };
  }

  if (msg.requestId && !rec) {
    return { handledByOwner: false, shouldUpdateGlobal: false };
  }

  const shouldUpdateGlobal =
    msg.workspaceId === currentGlobalWorkspaceId &&
    (!rec || (rec.epoch === globalGenerations.epoch && rec.generation >= globalGenerations.gitDiff));
  return { handledByOwner: false, shouldUpdateGlobal };
}

export function dispatchWorkspaceError(
  requestId: string | undefined,
  errorMessage: string,
  currentGlobalWorkspaceId?: string
): DispatchResult {
  if (!requestId) {
    return { handledByOwner: false, shouldUpdateGlobal: false };
  }
  const rec = untrackWorkspaceRequest(requestId);
  if (!rec) {
    return { handledByOwner: false, shouldUpdateGlobal: false };
  }
  if (rec.ownerId) {
    const state = useWorkspaceViewStore.getState();
    const view = state.views[rec.ownerId];
    if (view && view.workspaceId === rec.workspaceId) {
      const gens = getOwnerGens(rec.ownerId);
      // Epoch check
      if (rec.epoch !== gens.epoch) {
        return { handledByOwner: true, shouldUpdateGlobal: false };
      }
      // Generation check based on request type
      let isLatest = true;
      if (rec.type === "file.read") {
        isLatest = rec.generation === gens.fileRead && rec.path === view.selectedFilePath;
      } else if (rec.type === "workspace.gitDiff") {
        isLatest = rec.generation === gens.gitDiff && rec.path === view.selectedDiffPath;
      } else if (rec.type === "workspace.files") {
        const curGen = gens.dirFiles.get(rec.path || "") ?? 0;
        isLatest = rec.generation === curGen;
      } else if (rec.type === "workspace.git") {
        isLatest = rec.generation === gens.git;
      }

      if (isLatest) {
        useWorkspaceViewStore.setState((st) => {
          const current = st.views[rec.ownerId!];
          if (!current) return st;
          return {
            views: {
              ...st.views,
              [rec.ownerId!]: {
                ...current,
                filesLoading: false,
                gitLoaded: current.gitLoaded,
                error: errorMessage,
              },
            },
          };
        });
      }
    }
    return { handledByOwner: true, shouldUpdateGlobal: false };
  }

  // Global request: check epoch and workspace match
  let isGlobalLatest = rec.workspaceId === currentGlobalWorkspaceId && rec.epoch === globalGenerations.epoch;
  if (isGlobalLatest) {
    if (rec.type === "file.read") {
      isGlobalLatest = rec.generation === globalGenerations.fileRead;
    } else if (rec.type === "workspace.gitDiff") {
      isGlobalLatest = rec.generation === globalGenerations.gitDiff;
    } else if (rec.type === "workspace.files") {
      const curGen = globalGenerations.dirFiles.get(rec.path || "") ?? 0;
      isGlobalLatest = rec.generation === curGen;
    } else if (rec.type === "workspace.git") {
      isGlobalLatest = rec.generation === globalGenerations.git;
    }
  }

  return { handledByOwner: false, shouldUpdateGlobal: isGlobalLatest };
}

// Reset internal counters (for testing)
export function _resetWorkspaceViewInternalsForTest(): void {
  activeRequests.clear();
  ownerGenerations.clear();
  globalGenerations.epoch = 0;
  globalGenerations.dirFiles.clear();
  globalGenerations.fileRead = 0;
  globalGenerations.git = 0;
  globalGenerations.gitDiff = 0;
  useWorkspaceViewStore.setState({ views: {} });
}
