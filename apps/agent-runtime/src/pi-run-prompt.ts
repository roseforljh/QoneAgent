import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { MessageAttachmentInfo } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { runtimeText } from "./runtime-localization";
import { canProcessMediaAttachment, configuredCapabilities, mediaCapabilitiesContext } from "./media-capabilities";
import { googleMediaContent } from "./google-media";
import { imageContent, materializeModelInputs, promptWithAttachments } from "./pi-attachments";
import { parseAutomaticMediaDelegation } from "./pi-message-utils";
import { withMediaPhaseReporter } from "./media-phase";
import type { PiAdapter } from "./pi-adapter";

const log = createLogger("pi-adapter");
type Delegate = Parameters<PiAdapter["setSubagentDispatcher"]>[0];
type Catalog = ReturnType<Parameters<PiAdapter["setSubagentController"]>[0]["catalog"]>;

/** Prepare media and prompt context without giving old runs access to a replacement session. */
export async function promptPiRun(input: {
  sessionId: string; runId: string; message: string; session: AgentSession;
  opts: Parameters<PiAdapter["run"]>[2];
  capabilities?: ReturnType<typeof configuredCapabilities>;
  delegate?: Delegate; catalog?: Catalog; canDelegate: boolean;
  videoNotice: string; toolCatalog: string;
  webContext(): string; memoryContext(): string;
  signal: AbortSignal;
  phase(phase: "started" | "completed"): void;
}): Promise<void> {
  const { sessionId, runId, message, session, opts, capabilities, signal } = input;
  const selectedModel = session.agent.state.model;
  const isGoogle = selectedModel?.api === "google-generative-ai";
  const isCompletions = selectedModel?.api === "openai-completions";
  const attachments = opts.attachments;
  const missingAttachmentInput = capabilities && attachments?.some(attachment => !canProcessMediaAttachment(selectedModel!.api, capabilities.input, attachment));
  const nativeVideo = capabilities && attachments?.find(attachment => attachment.mimeType.startsWith("video/") && !capabilities.input.includes("video"));
  const routingCandidates = (missingAttachmentInput || nativeVideo) && input.canDelegate ? input.catalog : undefined;
  const videoSubagent = nativeVideo && input.canDelegate && !opts.subagentRunId
    ? routingCandidates?.capabilities.find(candidate => candidate.capability === "videoRecognition") : undefined;
  let delegation: ReturnType<typeof parseAutomaticMediaDelegation>;
  if (nativeVideo && videoSubagent && input.delegate) {
    try {
      const delegated = await input.delegate({
        capability: "videoRecognition", subagentId: null,
        parentSessionId: sessionId, parentRunId: runId, toolCallId: `media-routing-${runId}`,
        title: runtimeText("pi-adapter.video_recognition_subagent_title"), task: message,
        reason: runtimeText("pi-adapter.video_recognition_subagent_reason"),
        expectedResult: runtimeText("pi-adapter.video_recognition_subagent_expected_result"),
        mediaAttachment: nativeVideo, fallbackModel: opts.model,
        permissionMode: opts.permissionMode ?? "ask", serverIds: opts.serverIds ?? [], background: false, signal,
      });
      delegation = parseAutomaticMediaDelegation(delegated);
    } catch (error) {
      log.warn("automatic video subagent delegation failed", { runId, error: String(error) });
    }
  }
  signal.throwIfAborted();
  const modelAttachments: MessageAttachmentInfo[] | undefined = delegation
    ? attachments?.filter(attachment => !attachment.mimeType.startsWith("video/")) : attachments;
  const delegatedNotice = delegation
    ? runtimeText("pi-adapter.video_recognition_subagent_result", { p0: delegation.status, p1: delegation.result }) : "";
  const routingNotice = delegatedNotice || (routingCandidates
    ? runtimeText("pi-adapter.the_current_model_cannot_directly_read_some_attachments_only", { p0: JSON.stringify(routingCandidates) })
    : missingAttachmentInput && !input.canDelegate
      ? runtimeText("pi-adapter.the_current_model_cannot_directly_read_some_attachments_and") : "");
  const modelInputs = await materializeModelInputs(modelAttachments, isGoogle, capabilities?.input);
  signal.throwIfAborted();
  const webContext = input.webContext();
  const memoryContext = input.memoryContext();
  signal.throwIfAborted();
  await withMediaPhaseReporter(phase => { if (isGoogle) input.phase(phase); }, () => session.prompt([
    webContext, capabilities ? mediaCapabilitiesContext(capabilities) : "", routingNotice,
    delegation ? "" : input.videoNotice,
    promptWithAttachments(message, modelAttachments, Boolean(capabilities?.input.includes("video") || capabilities?.input.includes("audio")), capabilities?.input),
    input.toolCatalog, memoryContext,
  ].filter(Boolean).join("\n"), {
    images: isGoogle ? googleMediaContent(modelInputs, capabilities?.input)
      : [...imageContent(modelInputs, capabilities?.input), ...(isCompletions ? googleMediaContent(modelInputs?.filter(item => item.mimeType.startsWith("audio/")), capabilities?.input) : [])],
  }));
}
