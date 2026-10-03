import { z } from "zod";
import type { ModelMetadata, ProviderApiType } from "./model-metadata";
import type { AssistantMessagePart } from "./assistant-parts";
export { ACTIVITY_TITLE_TOOL, ACTIVITY_TITLE_MAX_LENGTH, activityTitleFromArgs } from "./activity-title";
import type { FilePreviewInfo } from "./file-preview";
import { isRuntimeMessageKey, type RuntimeLocale, type LocalizedErrorInfo, type RuntimeMessageKey } from "./localized-error";
export { runtimeMessage, isRuntimeMessageKey } from "./localized-error";
export type { RuntimeLocale, RuntimeMessageKey, LocalizedErrorInfo } from "./localized-error";

export { filePreviewKind } from "./file-preview";
export type { FilePreviewInfo, FilePreviewKind } from "./file-preview";

export { assistantPartsFromPiMessage, applyAssistantToolEvent, applyReasoningDelta } from "./assistant-parts";
export { sameUserInput, repeatedUserMessageId } from "./user-message-equality.js";
export { toolFileChanges, persistedToolResult } from "./file-changes";
export type { ToolFileChange } from "./file-changes";
export {
  detectImageModel,
  imageApiFormatForModelName,
  isImageApiFormat,
  isGeminiImageModelName,
  isGptImageModelName,
  isQwenImageModelName,
  isSeedreamModelName,
  supportsExtendedImageQuality,
} from "./image-model";
export type { ImageApiFormat, ImageModelDetection, ImageModelDetectionInput, ImageModelDetectionSource } from "./image-model";
export type { AssistantMessagePart, AssistantTextPhase } from "./assistant-parts";

export const GENERATIVE_UI_COMPONENTS = [
  "Header", "Text", "Caption", "Image", "Divider", "Fact", "Card",
  "Col", "Row", "Spacer", "Badge", "Box", "ListView",
  "ListViewItem", "Table", "Markdown", "Chart", "Alert", "Icon",
] as const;
export { isCodexSubscriptionEndpoint, modelBaseUrl, modelListUrl } from "./model-endpoint";
export { mediaMimeTypeFromName } from "./media-mime";
export {
  mergeModelMetadata,
  modelNameCandidates,
  modelNamesEqual,
  normalizeModelName,
  normalizeParameterName,
  parseModelMetadata,
  parseModelMetadataResponse,
} from "./model-metadata";
export type {
  ModelCapability,
  ModelMetadata,
  ModelReasoningOption,
  ParsedProviderModel,
  ProviderApiType,
} from "./model-metadata";
export type ModelMetadataSource = "provider" | "pi" | "models.dev" | "config" | "default";
export type ModelMetadataSources = Record<"contextWindow" | "maxTokens" | "reasoning" | "input" | "output", ModelMetadataSource>;

// Typed protocol between GUI and Agent Runtime.
// Commands: GUI -> Runtime. Events: Runtime -> GUI.
// Transport is NDJSON over stdio (Phase 2).

// ---------- Commands (GUI -> Runtime) ----------

export interface CommandBase {
  type: string;
  requestId: string;
}

export type RuntimeCommand = { locale?: RuntimeLocale } & (
  | { type: "ping"; requestId: string }
  | { type: "session.create"; requestId: string; title?: string; workspaceId: string }
  | { type: "session.side-chat.create"; requestId: string; sessionId: string; queueItemId?: string; title?: string }
  | { type: "session.generate-title"; requestId: string; sessionId: string; prompt: string; model?: string }
  | { type: "session.list"; requestId: string }
  | { type: "session.search"; requestId: string; query: string }
  | { type: "session.rename"; requestId: string; sessionId: string; title: string }
  | { type: "session.delete"; requestId: string; sessionId: string }
  | { type: "session.messages"; requestId: string; sessionId: string }
  | { type: "session.queue.list"; requestId: string; sessionId: string }
  | { type: "session.runs"; requestId: string; sessionId: string }
  | { type: "session.toolCalls"; requestId: string; sessionId: string }
  | { type: "session.subagents"; requestId: string; sessionId: string }
  | { type: "session.subagentNotifications"; requestId: string; sessionId: string }
  | { type: "goal.get"; requestId: string; sessionId: string }
  | { type: "goal.start"; requestId: string; sessionId: string; objective: string; attachments?: MessageAttachmentInfo[]; quote?: MessageQuoteInfo; messageId?: string; replaceFromMessageId?: string; model?: string; permissionMode?: RunPermissionMode; thinking?: RunThinkingLevel }
  | { type: "goal.pause"; requestId: string; sessionId: string; reason?: string }
  | { type: "goal.resume"; requestId: string; sessionId: string }
  | { type: "goal.clear"; requestId: string; sessionId: string }
  | { type: "artifact.list"; requestId: string; sessionId: string }
  | { type: "workspace.list"; requestId: string }
  | { type: "workspace.upsert"; requestId: string; name: string; path: string }
  | { type: "workspace.rename"; requestId: string; workspaceId: string; name: string }
  | { type: "workspace.delete"; requestId: string; workspaceId: string }
  | { type: "workspace.files"; requestId: string; workspaceId: string; path?: string }
  | { type: "workspace.git"; requestId: string; workspaceId: string }
  | { type: "workspace.gitDiff"; requestId: string; workspaceId: string; path: string; scope?: "staged" | "unstaged" }
  | { type: "file.read"; requestId: string; workspaceId: string; path: string }
  | { type: "file.preview"; requestId: string; workspaceId?: string; path: string; full?: boolean }
  | { type: "global-prompt.get"; requestId: string }
  | { type: "global-prompt.set"; requestId: string; content: string }
  | { type: "skills.list"; requestId: string; cwd?: string }
  | { type: "skills.cloud.list"; requestId: string; collection: "popular" | "trending" | "official"; page: number; query?: string }
  | { type: "skills.cloud.install"; requestId: string; source: string; skillId: string }
  | { type: "skills.import"; requestId: string; content: string }
  | { type: "skills.create"; requestId: string; name: string; description: string; instructions: string }
  | { type: "plugins.list"; requestId: string }
  | { type: "browser.status"; requestId: string }
  | { type: "browser.connect"; requestId: string }
  | { type: "reach.channels"; requestId: string }
  | { type: "reach.podcast.configure"; requestId: string; accessToken: string; refreshToken: string }
  | { type: "subagent.list"; requestId: string }
  | { type: "subagent.sync"; requestId: string; config: SubagentConfigInfo }
  | { type: "subagent.query"; requestId: string; runId: string }
  | { type: "subagent.control"; requestId: string; runId: string; action: SubagentControlAction; message?: string }
  | { type: "mcp.list"; requestId: string }
  | { type: "mcp.connect"; requestId: string; config: McpServerInfo }
  | { type: "mcp.delete"; requestId: string; serverId: string }
  | { type: "mcp.oauth.begin"; requestId: string; serverId: string }
  | { type: "mcp.oauth.complete"; requestId: string; serverId: string; code: string; state: string; iss?: string }
  | { type: "permission.list"; requestId: string }
  | { type: "permission.set"; requestId: string; subjectId: string; permission: string; decision: PermissionDecision }
  | { type: "compaction.settings.set"; requestId: string; autoCompactionEnabled: boolean; compactionThreshold: number }
  | { type: "session.compact"; requestId: string; sessionId: string; model: string }
  | { type: "session.context.get"; requestId: string; sessionId: string; model: string }
  | { type: "model.list"; requestId: string }
  | { type: "model.resolve-metadata"; requestId: string; provider: string; apiType: ProviderApiType; baseUrl: string; models: { id: string; metadata?: ModelMetadata }[] }
  | { type: "model.upsert"; requestId: string; config: ModelConfigInfo }
  | { type: "model.delete"; requestId: string; id: string }
  | { type: "events.replay"; requestId: string; sessionId?: string; afterSequence?: number }
  | {
      type: "agent.run";
      requestId: string;
      sessionId: string;
      message: string;
      goal?: boolean;
      goalContinuation?: boolean;
      attachments?: MessageAttachmentInfo[];
      quote?: MessageQuoteInfo;
      messageId?: string;
      replaceFromMessageId?: string;
      model?: string;
      permissionMode?: RunPermissionMode;
      thinking?: RunThinkingLevel;
      queueItemId?: string;
      mcpServerId?: string;
    }
  | { type: "agent.steer"; requestId: string; sessionId: string; runId: string; queueItemId: string; message: string; attachments?: MessageAttachmentInfo[]; quote?: MessageQuoteInfo }
  | { type: "queue.upsert"; requestId: string; sessionId: string; item: QueueItemInfo }
  | { type: "queue.edit"; requestId: string; sessionId: string; item: QueueItemInfo }
  | { type: "queue.sync"; requestId: string; sessionId: string; items: QueueItemInfo[] }
  | { type: "queue.remove"; requestId: string; sessionId: string; queueItemId: string }
  | { type: "agent.stop"; requestId: string; runId: string }
  | { type: "tool.approve"; requestId: string; approvalId: string }
  | { type: "tool.reject"; requestId: string; approvalId: string; reason?: string }
  | { type: "secret.set"; requestId: string; key: string; value: string }
  | { type: "secret.delete"; requestId: string; key: string });

// ---------- Events (Runtime -> GUI) ----------

export interface AgentEvent<T = unknown> {
  eventId: string;
  sessionId?: string;
  runId?: string;
  sequence: number;
  type: string;
  timestamp: number;
  payload: T;
  scope?: "conversation" | "subagent";
}

export interface EventBase {
  type: string;
}

export interface CompactionSettingsInfo {
  autoCompactionEnabled: boolean;
  compactionThreshold: number;
}

export interface CompactionMarkerInfo {
  id: string;
  throughMessageId: string;
  /** Ordered visible assistant-part boundary within this run. */
  runId?: string;
  partIndex?: number;
  createdAt: number;
  status: "completed" | "interrupted";
  source: "manual" | "automatic";
}

export interface LiveAssistantMessage {
  runId: string;
  content: string;
  parts: AssistantMessagePart[];
  messageSequence?: number;
  sequence: number;
}

export type RuntimeEvent =
  | { type: "pong"; requestId: string; capabilities?: string[]; compaction?: CompactionSettingsInfo }
  | { type: "session.compacted"; requestId: string; sessionId: string; marker: CompactionMarkerInfo }
  | { type: "session.compactionInterrupted"; requestId: string; sessionId: string; marker: CompactionMarkerInfo; message: string }
  | { type: "session.context"; requestId: string; sessionId: string; model: string; tokens: number; contextWindow: number }
  | { type: "session.created"; session: SessionInfo }
  | { type: "session.side-chat.created"; requestId: string; sessionId: string; queueItemId?: string; session: SessionInfo }
  | { type: "session.list"; sessions: SessionInfo[]; sideChats?: SessionInfo[] }
  | { type: "session.updated"; session: SessionInfo }
  | { type: "session.search"; requestId: string; query: string; results: SessionSearchResult[] }
  | { type: "session.renamed"; session: SessionInfo }
  | { type: "session.messages"; requestId?: string; sessionId: string; messages: MessageInfo[]; compactions?: CompactionMarkerInfo[]; streaming?: LiveAssistantMessage }
  | { type: "session.queue"; sessionId: string; items: QueueItemInfo[] }
  | { type: "session.runs"; sessionId: string; runs: RunInfo[] }
  | { type: "session.toolCalls"; sessionId: string; toolCalls: ToolCallInfo[] }
  | { type: "session.subagents"; sessionId: string; subagents: SubagentRunInfo[] }
  | { type: "session.subagentNotifications"; sessionId: string; notifications: SubagentNotificationInfo[] }
  | { type: "goal.current"; sessionId: string; goal?: GoalInfo }
  | { type: "goal.updated"; goal: GoalInfo }
  | { type: "goal.cleared"; sessionId: string; goalId: string }
  | { type: "subagent.updated"; subagent: SubagentRunInfo }
  | { type: "subagent.patch"; sessionId: string; id: string; patch: SubagentRunPatch }
  | { type: "subagent.streaming"; sessionId: string; id: string; delta: string; reasoning?: { delta: string; messageSequence: number; contentIndex?: number; complete?: boolean }[] }
  | { type: "artifact.list"; sessionId: string; artifacts: ArtifactInfo[] }
  | { type: "workspace.list"; workspaces: WorkspaceInfo[] }
  | { type: "workspace.updated"; workspace: WorkspaceInfo }
  | { type: "workspace.renamed"; workspace: WorkspaceInfo }
  | { type: "workspace.deleted"; workspaceId: string }
  | { type: "workspace.files"; requestId?: string; workspaceId: string; path?: string; files: WorkspaceFileInfo[] }
  | { type: "workspace.git"; requestId?: string; workspaceId: string; status: string; entries?: WorkspaceGitEntry[] }
  | { type: "skills.list"; skills: SkillInfo[] }
  | { type: "skills.cloud.list"; requestId: string; skills: CloudSkillInfo[]; page: number; total: number; pageSize: number; hasMore: boolean }
  | { type: "skills.cloud.installed"; requestId: string; skill: SkillInfo }
  | { type: "skills.imported"; requestId: string; skill: SkillInfo }
  | { type: "skills.created"; requestId: string; skill: SkillInfo }
  | { type: "plugins.list"; plugins: PluginInfo[] }
  | { type: "browser.status"; requestId?: string; status: BrowserSyncStatus }
  | { type: "reach.channels"; requestId?: string; channels: ReachChannelInfo[] }
  | { type: "subagent.list"; requestId?: string; config: SubagentConfigInfo }
  | { type: "subagent.query"; requestId: string; subagent: SubagentRunInfo }
  | { type: "subagent.controlled"; requestId: string; subagent: SubagentRunInfo }
  | { type: "mcp.list"; servers: McpServerInfo[] }
  | { type: "mcp.connected"; serverId: string; toolCount: number }
  | { type: "mcp.oauth.authorization"; requestId: string; serverId: string; url: string; state: string }
  | { type: "mcp.oauth.token"; requestId: string; serverId: string; key: string; accessToken: string }
  | { type: "mcp.oauth.saved"; serverId: string; key: string }
  | { type: "mcp.oauth.invalidated"; serverId: string; key: string }
  | { type: "mcp.oauth.credential"; serverId: string; key: string; value: string }
  | { type: "mcp.github.device"; serverId: string; userCode: string; verificationUri: string; expiresAt: number }
  | { type: "permission.list"; rules: PermissionRuleInfo[] }
  | { type: "permission.updated"; rule: PermissionRuleInfo }
  | { type: "model.list"; configs: ModelConfigInfo[] }
  | { type: "model.metadata-resolved"; requestId: string; models: { id: string; metadata: ModelMetadata; thinkingLevels: string[]; sources: ModelMetadataSources }[] }
  | { type: "model.updated"; config: ModelConfigInfo }
  | { type: "events.replay"; events: AgentEvent[] }
  | { type: "secret.saved"; requestId: string }
  | { type: "agent.event"; event: AgentEvent }
  | { type: "workspace.gitDiff"; requestId?: string; workspaceId: string; path: string; diff: string; truncated?: boolean }
  | { type: "file.read"; requestId?: string; workspaceId: string; path: string; content: string; binary?: boolean; truncated?: boolean }
  | { type: "file.preview"; requestId: string; workspaceId?: string; path: string; file: FilePreviewInfo }
  | { type: "global-prompt"; requestId: string; content: string; path: string; directory?: string }
  | { type: "terminal.data"; terminalId: string; data: string }
  | { type: "terminal.exit"; terminalId: string }
  | { type: "error"; requestId?: string; message: string; localization?: LocalizedErrorInfo };

// ---------- Shared shapes ----------

export interface SessionInfo {
  id: string;
  title: string;
  workspaceId?: string;
  createdAt: number;
  updatedAt: number;
  /** Timestamp of the latest message sent by the user; assistant output does not change it. */
  lastUserMessageAt?: number;
  sideChat?: { parentSessionId: string; boundaryMessageId: string };
}

export interface SessionSearchResult {
  session: SessionInfo;
  match: "title" | "content";
  snippet?: string;
}

export interface MessageInfo {
  id: string;
  sessionId: string;
  runId?: string;
  role: string;
  content: string;
  parts?: AssistantMessagePart[];
  attachments?: MessageAttachmentInfo[];
  quote?: MessageQuoteInfo;
  model?: string;
  goalId?: string;
  createdAt: number;
}

export type GoalStatus = "active" | "paused" | "blocked" | "complete";

export interface GoalInfo {
  id: string;
  sessionId: string;
  objective: string;
  status: GoalStatus;
  waitingReason?: string;
  waitingUntil?: number;
  stopReason?: string;
  epoch: number;
  createdAt: number;
  updatedAt: number;
}

export type QueueItemStatus = "queued" | "steering" | "scheduled";
export type QueueItemLane = "queue" | "steer";

export interface QueueItemInfo {
  id: string;
  sessionId: string;
  text: string;
  quote?: { text: string; messageId: string };
  attachments?: MessageAttachmentInfo[];
  lane: QueueItemLane;
  status: QueueItemStatus;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface MessageAttachmentInfo {
  type: "image" | "file" | "folder";
  name: string;
  mimeType: string;
  data: string;
  localPath?: string;
}

export interface MessageQuoteInfo {
  text: string;
  messageId: string;
}

export interface RunInfo {
  id: string;
  sessionId: string;
  status: RunStatus | "interrupted";
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface ToolCallInfo {
  id: string;
  runId: string;
  toolName: string;
  arguments?: string;
  resultSummary?: string;
  status: string;
  startedAt?: number;
  completedAt?: number;
}

export interface ArtifactInfo {
  id: string;
  sessionId: string;
  runId?: string;
  type: string;
  name: string;
  path: string;
  mimeType?: string;
  size?: number;
  createdAt: number;
}

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceFileInfo {
  path: string;
  kind: "file" | "directory";
}

export interface SubagentRunInfo {
  id: string;
  parentSessionId: string;
  parentRunId: string;
  parentSubagentId?: string;
  depth: number;
  toolCallId: string;
  executionSessionId?: string;
  background?: boolean;
  profileId?: string;
  title: string;
  task: string;
  model?: string;
  permissionMode?: RunPermissionMode;
  tools?: string[];
  status: RunInfo["status"];
  startedAt: number;
  completedAt?: number;
  content: string;
  parts: AssistantMessagePart[];
  streaming?: string;
  error?: string;
  turnCount: number;
  retryCount: number;
  workflowId?: string;
  workflowStepId?: string;
  dependsOn?: string[];
  contextMode?: SubagentContextMode;
  contextMessageCount?: number;
  tokenUsage?: SubagentTokenUsage;
  children?: string[];
  messages?: SubagentMessageInfo[];
}

/** Incremental fields sent while a child is active. History is never copied here. */
export type SubagentRunPatch = Pick<SubagentRunInfo, "id"> & Partial<Pick<SubagentRunInfo,
  "status" | "completedAt" | "content" | "error" | "turnCount" | "retryCount" | "tokenUsage" | "children"
>> & {
  streaming?: string | null;
  partsPatch?: { start: number; parts: AssistantMessagePart[] };
  messagesAppend?: SubagentMessageInfo[];
};

export type SubagentNotificationKind = "completed" | "failed" | "cancelled" | "interrupted";
export type SubagentNotificationStatus = "pending" | "delivered" | "acknowledged";

export interface SubagentNotificationInfo {
  id: string;
  sessionId: string;
  subagentRunId: string;
  version: number;
  kind: SubagentNotificationKind;
  status: SubagentNotificationStatus;
  title: string;
  summaryPreview?: string;
  createdAt: number;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

export interface SubagentMessageInfo {
  /** Runtime-expanded input; the original task or follow-up is shown instead. */
  internal?: boolean;
  id: string;
  sequence: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parts?: AssistantMessagePart[];
  createdAt: number;
}

export type SubagentControlAction = "stop" | "resume" | "retry" | "steer" | "follow_up";
export type SubagentContextMode = "task-only" | "snapshot";

export interface SubagentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: number;
}

export interface WorkspaceGitEntry {
  code: string;
  path: string;
  originalPath?: string;
}

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  toolCount: number;
  skillCount: number;
  loaded: boolean;
}

export interface McpServerInfo {
  id: string;
  name: string;
  connected?: boolean;
  toolCount?: number;
  command?: string;
  url?: string;
  tokenEnv?: string;
  args?: string[];
  env?: Record<string, string>;
  oauth?: McpOAuthInfo;
  authMode?: "oauth" | "github-device";
  oauthClientId?: string;
}

export function parseMcpCommand(message: string): { serverId: string; text: string } | undefined {
  const text = message.trimStart();
  const match = /^\/mcp:([^\s]+)(?:\s+|$)/u.exec(text);
  if (!match) return undefined;
  try {
    const serverId = decodeURIComponent(match[1]!);
    return serverId ? { serverId, text: text.slice(match[0].length).trimStart() } : undefined;
  } catch {
    return undefined;
  }
}

export interface CloudSkillInfo {
  source: string;
  skillId: string;
  name: string;
  installs: number;
  isOfficial: boolean;
}

export interface BrowserSyncStatus {
  phase: "connecting" | "syncing" | "ready" | "error";
  targetConnected: boolean;
  bookmarkCount?: number;
  historyCount?: number;
  libraryError?: string;
  lastError?: string;
  /** Machine-readable cause of the last connection failure; lastError stays human-readable. */
  errorCode?: "bridge-unavailable" | "npx-unavailable";
}

/** Error message code for a cloud skill catalog request that ran out of time. */
export const SKILL_CATALOG_TIMEOUT = "SKILL_CATALOG_TIMEOUT";

export const CAPABILITY_IDS = ["videoRecognition", "imageGeneration", "videoGeneration", "stt", "tts"] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export const builtinSubagentId = (capability: CapabilityId) => `builtin:${capability}`;
export const isBuiltinSubagentId = (id: string) => CAPABILITY_IDS.some((capability) => builtinSubagentId(capability) === id);
/** Retired built-ins are removed from saved configurations during migration. */
export const REMOVED_BUILTIN_SUBAGENT_IDS: readonly string[] = ["builtin:webSearch"];
export const SUBAGENT_LOGO_IDS = [
  "search", "video", "photo", "microphone", "volume", "sparkles", "robot", "code",
  "database", "brain", "chart-bar", "shield", "rocket", "palette", "cpu", "cloud",
  "git-branch", "terminal", "book", "bulb", "flame", "heart", "star", "target",
  "puzzle", "world", "bolt", "camera", "music", "leaf", "fingerprint", "antenna",
  "atom", "adjustments", "command", "bug", "cube", "key", "lock", "map",
  "messages", "moon", "sun", "trophy", "wand", "wind", "zoom", "abacus",
  "accessible", "acorn", "activity", "address-book", "affiliate", "air-balloon", "album", "alien",
  "anchor", "aperture", "api", "archive", "armchair", "award", "badge", "balloon",
  "ban", "basket", "battery", "bell", "bike", "blocks", "bookmark", "bottle",
  "box", "building", "calculator", "calendar", "car", "cat", "certificate", "chair-director",
  "chess", "circle-key", "clipboard", "clock", "coffee", "compass", "cookie", "crown",
  "device-desktop", "diamond", "dog", "door", "droplet", "eye", "feather", "file",
  "flag", "flower", "folder", "galaxy", "gift", "globe", "hammer", "headphones",
  "home", "hourglass", "ice-cream", "inbox", "infinity", "lamp", "lego", "lifebuoy",
  "live-photo", "mail", "man", "medal", "message", "meteor", "mouse", "news",
  "notebook", "package", "paperclip", "paw", "phone", "plant", "plug", "printer",
  "radio", "receipt", "recycle", "route", "school", "scissors", "settings", "ship",
  "shopping-bag", "speakerphone", "stairs", "stethoscope", "sunset", "tag", "tool", "tree",
  "umbrella", "user", "users", "wifi", "writing", "yoga",
] as const;
export type SubagentLogoId = (typeof SUBAGENT_LOGO_IDS)[number];
const builtinSubagentLogos: Record<CapabilityId, SubagentLogoId> = {
  videoRecognition: "video",
  imageGeneration: "photo",
  videoGeneration: "camera",
  stt: "microphone",
  tts: "volume",
};
export const builtinSubagentLogo = (capability: CapabilityId) => builtinSubagentLogos[capability];

export interface SubagentProfileInfo {
  id: string;
  name: string;
  instructions: string;
  /** Present only for untouched product defaults; user edits clear these keys. */
  nameKey?: RuntimeMessageKey;
  instructionsKey?: RuntimeMessageKey;
  modelId: string;
  logo?: string;
  enabled: boolean;
  tools?: string[];
  permissionMode?: RunPermissionMode;
  updatedAt: number;
}

export type CapabilityRouting = Partial<Record<CapabilityId, string>>;

export interface SubagentConfigInfo {
  profiles: SubagentProfileInfo[];
  routing: CapabilityRouting;
  runtime: SubagentRuntimeConfig;
  updatedAt: number;
}

export interface SubagentRuntimeConfig {
  /** Model used by AI-created temporary subagents when no saved profile is selected. Empty means follow the parent model. */
  temporaryModelId: string;
  maxConcurrent: number;
  timeoutMs: number;
  tokenBudget: number;
  contextMode: SubagentContextMode;
  contextMessages: number;
  allowNested: boolean;
  maxDepth: number;
  workflowMaxSteps: number;
  backgroundEnabled: boolean;
}

export const DEFAULT_SUBAGENT_RUNTIME: SubagentRuntimeConfig = {
  temporaryModelId: "",
  maxConcurrent: 4,
  timeoutMs: 30 * 60_000,
  tokenBudget: 0,
  contextMode: "snapshot",
  contextMessages: 20,
  allowNested: true,
  maxDepth: 3,
  workflowMaxSteps: 32,
  backgroundEnabled: true,
};

export interface ReachChannelInfo {
  id: string;
  name: string;
  description: string;
  backend: string;
  tools: string[];
  state: "available" | "unverified" | "needs-connection" | "unavailable";
  detail?: string;
  /** Built-in display copy travels with the channel so language changes need no refetch. */
  english?: { name: string; description: string; backend: string; detail?: string };
  action?: "opencli" | "exa" | "youtube" | "linkedin" | "podcast" | "xueqiu" | "github" | "bilibili";
}

export interface McpOAuthInfo {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  redirectUri?: string;
  tokenSecretKey?: string;
}

export type PermissionDecision = "allow" | "ask" | "deny";
export type RunPermissionMode = "ask" | "auto" | "full";
export type RunThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const API_THINKING_LEVELS: Record<ProviderApiType, readonly RunThinkingLevel[]> = {
  "openai-compatible": ["none", "low", "medium", "high"],
  codex: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
  claude: ["none", "low", "medium", "high", "max"],
  google: ["none", "minimal", "low", "medium", "high"],
};

export function thinkingLevelsForApi(apiType: ProviderApiType = "openai-compatible"): readonly RunThinkingLevel[] {
  return API_THINKING_LEVELS[apiType] ?? API_THINKING_LEVELS["openai-compatible"];
}

export function normalizeThinkingLevelForApi(value: unknown, apiType: ProviderApiType = "openai-compatible"): RunThinkingLevel {
  const available = thinkingLevelsForApi(apiType);
  if (available.includes(value as RunThinkingLevel)) return value as RunThinkingLevel;
  const order: readonly RunThinkingLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  const requestedIndex = order.indexOf(value as RunThinkingLevel);
  if (requestedIndex >= 0) {
    return order.slice(requestedIndex + 1).find((level) => available.includes(level))
      ?? [...order.slice(0, requestedIndex)].reverse().find((level) => available.includes(level))
      ?? available[0];
  }
  return available[0];
}
export interface PermissionRuleInfo {
  subjectId: string;
  permission: string;
  decision: PermissionDecision;
  updatedAt: number;
}

export interface ModelConfigInfo {
  id: string;
  provider: string;
  model: string;
  config: Record<string, unknown>;
  enabled: boolean;
  updatedAt: number;
}

export type RunStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

// ---------- Wire helpers (NDJSON) ----------

export function encode<T>(msg: T): string {
  return JSON.stringify(msg) + "\n";
}

export function decode<T = unknown>(line: string): T | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return null;
  }
}

export function isSecureServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

const request = { requestId: z.string().min(1), locale: z.enum(["en", "zh-CN"]).optional() };
const id = z.string().min(1);
const secureUrl = z.string().url().refine(isSecureServiceUrl, "URL must use HTTPS or loopback HTTP");
const secretKey = z.string().regex(/^[A-Za-z][A-Za-z0-9.-]{0,63}:[A-Za-z0-9._/-]{1,128}$/);
const decision = z.enum(["allow", "ask", "deny"]);
const mcpConfig = z.object({
  id, name: id, command: z.string().min(1).optional(), url: secureUrl.optional(),
  tokenEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(), args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  authMode: z.enum(["oauth", "github-device"]).optional(),
  oauthClientId: z.string().min(1).optional(),
  oauth: z.object({
    authorizationUrl: secureUrl, tokenUrl: secureUrl, clientId: id,
    scopes: z.array(z.string()).optional(), redirectUri: secureUrl.optional(), tokenSecretKey: z.string().optional(),
  }).optional(),
}).refine((config) => Boolean(config.command) !== Boolean(config.url) && (!config.authMode || Boolean(config.url)));
export const DIRECTORY_MIME_TYPE = "inode/directory";

const messageAttachment = z.object({
  type: z.enum(["image", "file", "folder"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  data: z.string(),
  localPath: z.string().min(1).max(4096).optional(),
}).refine((attachment) => attachment.type === "folder"
  ? attachment.mimeType === DIRECTORY_MIME_TYPE && Boolean(attachment.localPath) && attachment.data === ""
  : attachment.localPath
  ? attachment.data === "" && (attachment.type !== "image" || /^image\/(png|jpeg|webp|gif)$/i.test(attachment.mimeType))
  : (/^(?:audio|video)\//i.test(attachment.mimeType) || attachment.data.length <= 70_000_000) &&
    /^data:[^,]*;base64,[A-Za-z0-9+/=]+$/i.test(attachment.data) &&
    attachment.data.toLowerCase().startsWith(`data:${attachment.mimeType.toLowerCase()}`) &&
    (attachment.type !== "image" || /^image\/(png|jpeg|webp|gif)$/i.test(attachment.mimeType)));
const nonMediaAttachmentBytes = (attachments: readonly { data: string; mimeType: string }[] | undefined) =>
  attachments?.reduce((total, attachment) => total + (/^(?:audio|video)\//i.test(attachment.mimeType) ? 0 : attachment.data.length), 0) ?? 0;
const subagentProfile = z.object({
  id: id.max(128), name: z.string().trim().min(1).max(120),
  instructions: z.string().trim().min(1).max(32_000), modelId: z.string().max(512), logo: z.string().trim().min(1).max(64).optional(),
  nameKey: z.string().refine(isRuntimeMessageKey).optional(),
  instructionsKey: z.string().refine(isRuntimeMessageKey).optional(),
  enabled: z.boolean(), tools: z.array(z.string().regex(/^[a-zA-Z0-9_:-]+$/).max(64)).max(100).optional(),
  permissionMode: z.enum(["ask", "auto", "full"]).optional(), updatedAt: z.number().int().nonnegative(),
}).refine((profile) => Boolean(profile.modelId) || isBuiltinSubagentId(profile.id), "A custom subagent needs a model");
const subagentConfig = z.object({
  profiles: z.array(subagentProfile).max(100),
  routing: z.record(z.string(), z.string().max(512)).optional().default({}),
  runtime: z.object({
    temporaryModelId: z.string().max(512).optional(),
    maxConcurrent: z.number().int().min(1).max(32).optional(),
    timeoutMs: z.number().int().min(10_000).max(86_400_000).optional(),
    tokenBudget: z.number().int().min(0).max(10_000_000).optional(),
    contextMode: z.enum(["task-only", "snapshot"]).optional(),
    contextMessages: z.number().int().min(0).max(100).optional(),
    allowNested: z.boolean().optional(),
    maxDepth: z.number().int().min(1).max(8).optional(),
    workflowMaxSteps: z.number().int().min(1).max(128).optional(),
    backgroundEnabled: z.boolean().optional(),
  }).optional().default({}),
  updatedAt: z.number().int().nonnegative(),
});
const commandSchemas: Record<string, z.ZodTypeAny> = {
  ping: z.object({ type: z.literal("ping"), ...request }),
  "session.create": z.object({ type: z.literal("session.create"), ...request, title: z.string().optional(), workspaceId: id }),
  "session.side-chat.create": z.object({ type: z.literal("session.side-chat.create"), ...request, sessionId: id, queueItemId: id.optional(), title: id.optional() }),
  "session.generate-title": z.object({ type: z.literal("session.generate-title"), ...request, sessionId: id, prompt: z.string().min(1), model: z.string().optional() }),
  "session.list": z.object({ type: z.literal("session.list"), ...request }),
  "session.search": z.object({ type: z.literal("session.search"), ...request, query: z.string().trim().min(1).max(200) }),
  "session.rename": z.object({ type: z.literal("session.rename"), ...request, sessionId: id, title: id }),
  "session.delete": z.object({ type: z.literal("session.delete"), ...request, sessionId: id }),
  "session.messages": z.object({ type: z.literal("session.messages"), ...request, sessionId: id }),
  "session.queue.list": z.object({ type: z.literal("session.queue.list"), ...request, sessionId: id }),
  "session.runs": z.object({ type: z.literal("session.runs"), ...request, sessionId: id }),
  "session.toolCalls": z.object({ type: z.literal("session.toolCalls"), ...request, sessionId: id }),
  "session.subagents": z.object({ type: z.literal("session.subagents"), ...request, sessionId: id }),
  "session.subagentNotifications": z.object({ type: z.literal("session.subagentNotifications"), ...request, sessionId: id }),
  "goal.get": z.object({ type: z.literal("goal.get"), ...request, sessionId: id }),
  "goal.start": z.object({ type: z.literal("goal.start"), ...request, sessionId: id, objective: z.string().trim().min(1), attachments: z.array(messageAttachment).optional(), quote: z.object({ text: z.string().trim().min(1).max(100_000), messageId: id }).optional(), messageId: id.optional(), replaceFromMessageId: id.optional(), model: z.string().optional(), permissionMode: z.enum(["ask", "auto", "full"]).optional(), thinking: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional() }).refine((goal) => nonMediaAttachmentBytes(goal.attachments) <= 140_000_000, "Goal attachments exceed the maximum size"),
  "goal.pause": z.object({ type: z.literal("goal.pause"), ...request, sessionId: id, reason: z.string().optional() }),
  "goal.resume": z.object({ type: z.literal("goal.resume"), ...request, sessionId: id }),
  "goal.clear": z.object({ type: z.literal("goal.clear"), ...request, sessionId: id }),
  "artifact.list": z.object({ type: z.literal("artifact.list"), ...request, sessionId: id }),
  "workspace.list": z.object({ type: z.literal("workspace.list"), ...request }),
  "workspace.upsert": z.object({ type: z.literal("workspace.upsert"), ...request, name: id, path: id }),
  "workspace.rename": z.object({ type: z.literal("workspace.rename"), ...request, workspaceId: id, name: id }),
  "workspace.delete": z.object({ type: z.literal("workspace.delete"), ...request, workspaceId: id }),
  "workspace.files": z.object({ type: z.literal("workspace.files"), ...request, workspaceId: id, path: z.string().optional() }),
  "workspace.git": z.object({ type: z.literal("workspace.git"), ...request, workspaceId: id }),
  "workspace.gitDiff": z.object({ type: z.literal("workspace.gitDiff"), ...request, workspaceId: id, path: id, scope: z.enum(["staged", "unstaged"]).optional() }),
  "file.read": z.object({ type: z.literal("file.read"), ...request, workspaceId: id, path: id }),
  "file.preview": z.object({ type: z.literal("file.preview"), ...request, workspaceId: id.optional(), path: id, full: z.boolean().optional() }),
  "skills.list": z.object({ type: z.literal("skills.list"), ...request, cwd: z.string().optional() }),
  "skills.cloud.list": z.object({ type: z.literal("skills.cloud.list"), ...request, collection: z.enum(["popular", "trending", "official"]), page: z.number().int().min(1).max(200), query: z.string().max(100).optional() }),
  "skills.cloud.install": z.object({ type: z.literal("skills.cloud.install"), ...request, source: z.string().max(200), skillId: z.string().max(64) }),
  "skills.import": z.object({ type: z.literal("skills.import"), ...request, content: z.string().min(1).max(2_097_152) }),
  "skills.create": z.object({ type: z.literal("skills.create"), ...request, name: z.string().max(64), description: z.string().max(500), instructions: z.string().min(1).max(2_000_000) }),
  "plugins.list": z.object({ type: z.literal("plugins.list"), ...request }),
  "browser.status": z.object({ type: z.literal("browser.status"), ...request }),
  "browser.connect": z.object({ type: z.literal("browser.connect"), ...request }),
  "reach.channels": z.object({ type: z.literal("reach.channels"), ...request }),
  "reach.podcast.configure": z.object({ type: z.literal("reach.podcast.configure"), ...request, accessToken: z.string().min(8).max(8192), refreshToken: z.string().min(8).max(8192) }),
  "subagent.list": z.object({ type: z.literal("subagent.list"), ...request }),
  "subagent.sync": z.object({ type: z.literal("subagent.sync"), ...request, config: subagentConfig }),
  "subagent.query": z.object({ type: z.literal("subagent.query"), ...request, runId: id }),
  "subagent.control": z.object({ type: z.literal("subagent.control"), ...request, runId: id, action: z.enum(["stop", "resume", "retry", "steer", "follow_up"]), message: z.string().max(32_000).optional() }),
  "mcp.list": z.object({ type: z.literal("mcp.list"), ...request }),
  "mcp.connect": z.object({ type: z.literal("mcp.connect"), ...request, config: mcpConfig }),
  "mcp.delete": z.object({ type: z.literal("mcp.delete"), ...request, serverId: id }),
  "mcp.oauth.begin": z.object({ type: z.literal("mcp.oauth.begin"), ...request, serverId: id }),
  "mcp.oauth.complete": z.object({ type: z.literal("mcp.oauth.complete"), ...request, serverId: id, code: id, state: id, iss: secureUrl.optional() }),
  "model.list": z.object({ type: z.literal("model.list"), ...request }),
  "model.resolve-metadata": z.object({ type: z.literal("model.resolve-metadata"), ...request, provider: id, apiType: z.enum(["openai-compatible", "codex", "claude", "google"]), baseUrl: z.string().max(2048), models: z.array(z.object({ id, metadata: z.record(z.string(), z.unknown()).optional() })).min(1).max(500) }),
  "model.upsert": z.object({ type: z.literal("model.upsert"), ...request, config: z.object({ id: id.optional(), provider: id, model: id, config: z.record(z.string(), z.unknown()).optional(), enabled: z.boolean().optional(), updatedAt: z.number().optional() }) }),
  "model.delete": z.object({ type: z.literal("model.delete"), ...request, id }),
  "events.replay": z.object({ type: z.literal("events.replay"), ...request, sessionId: id.optional(), afterSequence: z.number().optional() }),
  "agent.run": z.object({ type: z.literal("agent.run"), ...request, sessionId: id, message: z.string(), goal: z.boolean().optional(), goalContinuation: z.boolean().optional(), attachments: z.array(messageAttachment).optional(), quote: z.object({ text: z.string().trim().min(1).max(100_000), messageId: id }).optional(), messageId: id.optional(), replaceFromMessageId: id.optional(), model: z.string().optional(), permissionMode: z.enum(["ask", "auto", "full"]).optional(), thinking: z.enum(["none", "minimal", "medium", "high", "xhigh", "max"]).optional(), queueItemId: id.optional(), mcpServerId: id.optional() }).refine((run) => Boolean(run.message.trim() || run.attachments?.length) && nonMediaAttachmentBytes(run.attachments) <= 140_000_000, "Message or valid attachments required"),
  "global-prompt.get": z.object({ type: z.literal("global-prompt.get"), ...request }),
  "global-prompt.set": z.object({ type: z.literal("global-prompt.set"), ...request, content: z.string().max(200_000) }),
  "agent.steer": z.object({ type: z.literal("agent.steer"), ...request, sessionId: id, runId: id, queueItemId: id, message: z.string(), attachments: z.array(messageAttachment).optional(), quote: z.object({ text: z.string().trim().min(1).max(100_000), messageId: id }).optional() }).refine((run) => Boolean(run.message.trim() || run.attachments?.length), "Message or valid attachments required"),
  "queue.upsert": z.object({ type: z.literal("queue.upsert"), ...request, sessionId: id, item: z.object({ id, sessionId: id, text: z.string(), quote: z.object({ text: z.string().trim().min(1).max(100_000), messageId: id }).optional(), attachments: z.array(messageAttachment).optional(), lane: z.enum(["queue", "steer"]), status: z.enum(["queued", "steering", "scheduled"]), position: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() }) }),
  "queue.edit": z.object({ type: z.literal("queue.edit"), ...request, sessionId: id, item: z.object({ id, sessionId: id, text: z.string(), quote: z.object({ text: z.string().trim().min(1).max(100_000), messageId: id }).optional(), attachments: z.array(messageAttachment).optional(), lane: z.enum(["queue", "steer"]), status: z.enum(["queued", "steering", "scheduled"]), position: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() }) }),
  "queue.sync": z.object({ type: z.literal("queue.sync"), ...request, sessionId: id, items: z.array(z.object({ id, sessionId: id, text: z.string(), quote: z.object({ text: z.string().trim().min(1).max(100_000), messageId: id }).optional(), attachments: z.array(messageAttachment).optional(), lane: z.enum(["queue", "steer"]), status: z.enum(["queued", "steering", "scheduled"]), position: z.number().int().nonnegative(), createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative() })).max(100) }),
  "queue.remove": z.object({ type: z.literal("queue.remove"), ...request, sessionId: id, queueItemId: id }),
  "agent.stop": z.object({ type: z.literal("agent.stop"), ...request, runId: id }),
  "tool.approve": z.object({ type: z.literal("tool.approve"), ...request, approvalId: id }),
  "tool.reject": z.object({ type: z.literal("tool.reject"), ...request, approvalId: id, reason: z.string().optional() }),
  "permission.list": z.object({ type: z.literal("permission.list"), ...request }),
  "permission.set": z.object({ type: z.literal("permission.set"), ...request, subjectId: id, permission: id, decision }),
  "compaction.settings.set": z.object({ type: z.literal("compaction.settings.set"), ...request, autoCompactionEnabled: z.boolean(), compactionThreshold: z.number().int().min(50).max(95) }),
  "session.compact": z.object({ type: z.literal("session.compact"), ...request, sessionId: id, model: id }),
  "session.context.get": z.object({ type: z.literal("session.context.get"), ...request, sessionId: id, model: id }),
  "secret.set": z.object({ type: z.literal("secret.set"), ...request, key: secretKey, value: z.string().max(65_536) }),
  "secret.delete": z.object({ type: z.literal("secret.delete"), ...request, key: secretKey }),
};

/** Validate untrusted IPC input at the process boundary before dispatch. */
export function decodeCommand(line: string): RuntimeCommand | null {
  const value = decode<unknown>(line);
  if (!value || typeof value !== "object" || !("type" in value)) return null;
  const schema = commandSchemas[String((value as { type: unknown }).type)];
  if (!schema) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data as RuntimeCommand : null;
}
