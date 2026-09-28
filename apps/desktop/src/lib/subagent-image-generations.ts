import { builtinSubagentId, detectImageModel, type ModelConfigInfo, type SubagentRunInfo } from "@qone/protocol";
import { isImageModel } from "./image-model-config";

export interface SubagentImageGeneration {
  id: string;
  prompt: string;
  generating: boolean;
  error?: string;
  missingImage?: boolean;
}

/** Only image-capable children of this main run get a generation card. */
export function subagentImageGenerations(
  subagents: readonly SubagentRunInfo[],
  parentRunId: string | undefined,
  models: readonly ModelConfigInfo[],
): SubagentImageGeneration[] {
  if (!parentRunId) return [];
  return subagents.flatMap((child) => {
    if (child.parentRunId !== parentRunId || child.parentSubagentId) return [];
    const configuredModel = models.find((model) => model.id === child.model);
    const imageModel = configuredModel
      ? isImageModel(configuredModel)
      : Boolean(child.model && detectImageModel({ model: child.model }).isImageModel);
    if (child.profileId !== builtinSubagentId("imageGeneration") && !imageModel) return [];
    if (child.status === "cancelled" || child.status === "interrupted") return [];
    const hasImage = child.parts.some((part) => part.type === "image" && Boolean(part.image));
    if (child.status === "completed" && hasImage) return [];
    const generating = ["created", "running", "waiting_approval", "paused"].includes(child.status);
    return [{
      id: child.id,
      prompt: child.task,
      generating,
      error: generating ? undefined : child.error,
      missingImage: !generating && !child.error,
    }];
  });
}
