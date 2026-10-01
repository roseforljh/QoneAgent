import { useEffect, useMemo, useState } from "react";
import type { ChatMessage, ChatRunError, ToolCall } from "../store";
import type { AssistantMessagePart, ModelConfigInfo } from "@qone/protocol";
import { useLocale } from "../localization";
import { createMessageConverter } from "./runtime-message-converter";
import { insertChatRunErrorMessage } from "./chat-run-error-message";
import { isImageModel } from "./image-model-config";
import { localImagePreview } from "./local-image-preview";
import { appendSteeringMessages } from "./use-steering-messages";
import type { subagentImagesByRun } from "./subagent-images";

type ConversationMessages = {
  messages: ChatMessage[]; streaming: string; streamingParts: AssistantMessagePart[];
  running: boolean; activeRunId?: string; currentSessionId?: string;
  selectedModel?: ModelConfigInfo; chatRunError?: ChatRunError; toolCalls: ToolCall[];
  childImagesByRun: ReturnType<typeof subagentImagesByRun>;
};

/** Both placements use the same message conversion and media/error handling. */
export function useConversationMessages({ messages, streaming, streamingParts, running, activeRunId, currentSessionId, selectedModel, chatRunError, toolCalls, childImagesByRun }: ConversationMessages, submittedSteers: ChatMessage[]) {
  const { t } = useLocale();
  const hasStreamingAssistant = running;
  const imageGenerationError = !hasStreamingAssistant && chatRunError && chatRunError.sessionId === currentSessionId && chatRunError.userMessageId && isImageModel(selectedModel)
    ? messages.find((message) => message.id === chatRunError.userMessageId)
    : undefined;
  const answerError = !hasStreamingAssistant && chatRunError?.sessionId === currentSessionId && !imageGenerationError ? chatRunError : undefined;
  const runtimeMessages = useMemo(() => {
    // An empty current segment is authoritative: undefined would replay legacy tools from this run.
    if (hasStreamingAssistant) return appendSteeringMessages([...messages, { id: "streaming", role: "assistant", content: streaming, parts: streamingParts, runId: activeRunId, createdAt: messages.at(-1)?.createdAt ?? Date.now() }], submittedSteers);
    if (imageGenerationError) return [...messages, { id: `image-error:${imageGenerationError.id}`, role: "assistant", content: "", createdAt: Date.now() }];
    if (answerError) return insertChatRunErrorMessage(messages, answerError, `${t("chat.runFailed")}\n${answerError.detail || t("chat.runFailedDetail")}`);
    return messages;
  }, [messages, streaming, streamingParts, activeRunId, hasStreamingAssistant, imageGenerationError, answerError, submittedSteers, t]);
  const [imagePreviews, setImagePreviews] = useState<Record<string, string>>({});
  const imageAttachmentMessages = useMemo(() => appendSteeringMessages(messages, submittedSteers), [messages, submittedSteers]);
  useEffect(() => {
    const paths = [...new Set(imageAttachmentMessages.flatMap((message) => message.attachments?.flatMap((attachment) =>
      attachment.type === "image" && attachment.localPath ? [attachment.localPath] : []) ?? []))];
    let active = true;
    void Promise.all(paths.map(async (path) => {
      try { return [path, await localImagePreview(path)] as const; }
      catch { return undefined; }
    })).then((entries) => {
      if (!active) return;
      setImagePreviews((current) => {
        const next = { ...current };
        let changed = false;
        for (const entry of entries) if (entry && next[entry[0]] !== entry[1]) {
          next[entry[0]] = entry[1];
          changed = true;
        }
        return changed ? next : current;
      });
    });
    return () => { active = false; };
  }, [imageAttachmentMessages]);
  const imageWindows = useMemo(() => {
    const windows = new Map<string, { after?: number; through?: number }>();
    const lastAssistantByRun = new Map<string, number>();
    for (const message of messages) {
      if (message.role !== "assistant" || !message.runId) continue;
      windows.set(message.id, {
        after: lastAssistantByRun.get(message.runId),
        through: message.createdAt,
      });
      if (message.createdAt !== undefined) lastAssistantByRun.set(message.runId, message.createdAt);
    }
    if (running && activeRunId) windows.set("streaming", { after: lastAssistantByRun.get(activeRunId) });
    return windows;
  }, [messages, running, activeRunId]);
  const toolCallsByRun = useMemo(() => {
    const grouped = new Map<string, ToolCall[]>();
    for (const call of toolCalls) {
      const current = grouped.get(call.runId) ?? [];
      current.push(call);
      grouped.set(call.runId, current);
    }
    return grouped;
  }, [toolCalls]);

  const convertMessage = useMemo(createMessageConverter, []);
  const convertedMessages = useMemo(() => {
    const context = {
      imagePreviews, toolCallsByRun, imageWindows, childImagesByRun, running,
      imageModel: isImageModel(selectedModel), imageGenerationError, chatRunErrorDetail: chatRunError?.detail,
    };
    return runtimeMessages.map((message) => convertMessage(message, context));
  }, [runtimeMessages, convertMessage, imagePreviews, toolCallsByRun, imageWindows, childImagesByRun, running, selectedModel, imageGenerationError, chatRunError?.detail]);

  return convertedMessages;
}
