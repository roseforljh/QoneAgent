import { modelBaseUrl, type ImageApiFormat, type MessageAttachmentInfo, type ModelConfigInfo } from "@qone/protocol";

export type GeneratedImagePart =
  | { type: "text"; text: string }
  | { type: "image"; image: string; filename?: string };

export interface ImageGenerationRequest {
  config: ModelConfigInfo;
  format: ImageApiFormat;
  prompt: string;
  attachments?: MessageAttachmentInfo[];
  apiKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function settingsOf(config: ModelConfigInfo): RecordValue {
  return record(config.config) ?? {};
}

function imageSettings(config: ModelConfigInfo): RecordValue {
  return record(settingsOf(config).imageGeneration) ?? {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function imageAttachments(attachments: MessageAttachmentInfo[] | undefined): MessageAttachmentInfo[] {
  return attachments?.filter((attachment) => attachment.type === "image") ?? [];
}

function dataUrlToParts(value: string): { mimeType: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(value);
  return match ? { mimeType: match[1]!, data: match[2]! } : undefined;
}

function baseUrl(config: ModelConfigInfo, format: ImageApiFormat): string {
  const raw = String(settingsOf(config).baseUrl ?? "");
  return modelBaseUrl(format === "gemini-image" ? "google" : "openai-compatible", raw);
}

function appendPath(base: string, suffix: string): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
  return url.toString();
}

function promptText(prompt: string): string {
  return prompt.trim() || "Generate an image";
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

function jsonRequest(url: string, body: RecordValue, headers: Record<string, string>, signal: AbortSignal): RequestInit {
  return { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body), signal };
}

function commonOpenAiImageFields(config: ModelConfigInfo, prompt: string): RecordValue {
  const settings = imageSettings(config);
  const outputFormat = stringValue(settings.outputFormat);
  return {
    model: config.model,
    prompt: promptText(prompt),
    ...(stringValue(settings.size) && settings.size !== "auto" ? { size: settings.size } : {}),
    ...(stringValue(settings.quality) && settings.quality !== "auto" ? { quality: settings.quality } : {}),
    ...(stringValue(settings.background) && settings.background !== "auto" ? { background: settings.background } : {}),
    ...(stringValue(settings.outputFormat) ? { output_format: settings.outputFormat } : {}),
    ...(numberValue(settings.outputCompression) !== undefined && (outputFormat === "jpeg" || outputFormat === "webp") ? { output_compression: settings.outputCompression } : {}),
    ...(stringValue(settings.moderation) && settings.moderation !== "auto" ? { moderation: settings.moderation } : {}),
    ...(numberValue(settings.n) !== undefined && Number(settings.n) > 1 ? { n: Math.floor(Number(settings.n)) } : {}),
  };
}

function buildOpenAiRequest(input: ImageGenerationRequest): { url: string; init: RequestInit } {
  const images = imageAttachments(input.attachments);
  const endpoint = appendPath(baseUrl(input.config, input.format), images.length ? "images/edits" : "images/generations");
  const body = commonOpenAiImageFields(input.config, input.prompt);
  if (!images.length) return { url: endpoint, init: jsonRequest(endpoint, body, authHeaders(input.apiKey), input.signal) };
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.append(key, String(value));
  for (const attachment of images) {
    const parsed = dataUrlToParts(attachment.data);
    if (!parsed) throw new Error(`Unsupported image attachment: ${attachment.name}`);
    form.append("image[]", new Blob([Buffer.from(parsed.data, "base64")], { type: parsed.mimeType }), attachment.name || "reference.png");
  }
  return { url: endpoint, init: { method: "POST", headers: authHeaders(input.apiKey), body: form, signal: input.signal } };
}

function buildGeminiRequest(input: ImageGenerationRequest): { url: string; init: RequestInit } {
  const settings = imageSettings(input.config);
  const inputParts: Array<RecordValue> = [{ type: "text", text: promptText(input.prompt) }];
  for (const attachment of imageAttachments(input.attachments)) {
    const parsed = dataUrlToParts(attachment.data);
    if (!parsed) throw new Error(`Unsupported image attachment: ${attachment.name}`);
    inputParts.push({ type: "image", mime_type: parsed.mimeType, data: parsed.data });
  }
  const responseFormat = {
    type: "image",
    mime_type: stringValue(settings.outputFormat) === "jpeg" ? "image/jpeg" : stringValue(settings.outputFormat) === "webp" ? "image/webp" : "image/png",
    ...(stringValue(settings.aspectRatio) && settings.aspectRatio !== "auto" ? { aspect_ratio: settings.aspectRatio } : {}),
    ...(stringValue(settings.imageSize) && settings.imageSize !== "auto" ? { image_size: settings.imageSize } : {}),
  };
  const body: RecordValue = {
    model: input.config.model,
    input: inputParts,
    response_format: responseFormat,
  };
  const endpoint = appendPath(baseUrl(input.config, input.format), "interactions");
  return { url: endpoint, init: jsonRequest(endpoint, body, { "x-goog-api-key": input.apiKey, Accept: "application/json" }, input.signal) };
}

function qwenDashScope(input: ImageGenerationRequest): boolean {
  const settings = settingsOf(input.config);
  const transport = stringValue(settings.imageTransport ?? imageSettings(input.config).transport)?.toLowerCase();
  if (transport === "dashscope") return true;
  if (transport === "openai-compatible" || transport === "openai") return false;
  return /(?:dashscope|aliyuncs|alibabacloud)/i.test(String(settings.baseUrl ?? "")) || /(?:dashscope|qwen|aliyun|alibaba)/i.test(input.config.provider);
}

function dashScopeEndpoint(config: ModelConfigInfo, asynchronous = false): string {
  const raw = String(settingsOf(config).baseUrl ?? "");
  const normalized = modelBaseUrl("openai-compatible", raw);
  const url = new URL(normalized);
  if (!/\/api\/v\d+$/i.test(url.pathname)) url.pathname = "/api/v1";
  return appendPath(url.toString(), `services/aigc/${asynchronous ? "image-generation" : "multimodal-generation"}/generation`);
}

function qwenMessageContent(input: ImageGenerationRequest): Array<RecordValue> {
  return [
    ...imageAttachments(input.attachments).map((attachment) => ({ image: attachment.data })),
    { text: promptText(input.prompt) },
  ];
}

function buildQwenRequest(input: ImageGenerationRequest): { url: string; init: RequestInit } {
  const settings = imageSettings(input.config);
  if (qwenDashScope(input)) {
    const asynchronous = settings.async === true || settings.asynchronous === true;
    const body: RecordValue = {
      model: input.config.model,
      input: { messages: [{ role: "user", content: qwenMessageContent(input) }] },
      parameters: {
        ...(stringValue(settings.negativePrompt) ? { negative_prompt: settings.negativePrompt } : {}),
        ...(typeof settings.promptExtend === "boolean" ? { prompt_extend: settings.promptExtend } : {}),
        ...(stringValue(settings.promptExtendMode) ? { prompt_extend_mode: settings.promptExtendMode } : {}),
        ...(typeof settings.enableThinking === "boolean" ? { enable_thinking: settings.enableThinking } : {}),
        ...(typeof settings.watermark === "boolean" ? { watermark: settings.watermark } : {}),
        ...(numberValue(settings.n) !== undefined ? { n: Math.floor(Number(settings.n)) } : {}),
        ...(stringValue(settings.size) && settings.size !== "auto" ? { size: settings.size } : {}),
        ...(numberValue(settings.seed) !== undefined ? { seed: Math.floor(Number(settings.seed)) } : {}),
      },
    };
    const endpoint = dashScopeEndpoint(input.config, asynchronous);
    return { url: endpoint, init: jsonRequest(endpoint, body, { ...authHeaders(input.apiKey), ...(asynchronous ? { "X-DashScope-Async": "enable" } : {}) }, input.signal) };
  }
  const body: RecordValue = {
    ...commonOpenAiImageFields(input.config, input.prompt),
    ...(imageAttachments(input.attachments).length ? { image: imageAttachments(input.attachments).length === 1 ? imageAttachments(input.attachments)[0]!.data : imageAttachments(input.attachments).map((attachment) => attachment.data) } : {}),
    ...(stringValue(settings.negativePrompt) ? { negative_prompt: settings.negativePrompt } : {}),
    ...(typeof settings.promptExtend === "boolean" ? { prompt_extend: settings.promptExtend } : {}),
    ...(stringValue(settings.promptExtendMode) ? { prompt_extend_mode: settings.promptExtendMode } : {}),
    ...(typeof settings.enableThinking === "boolean" ? { enable_thinking: settings.enableThinking } : {}),
    ...(typeof settings.watermark === "boolean" ? { watermark: settings.watermark } : {}),
    ...(numberValue(settings.seed) !== undefined ? { seed: Math.floor(Number(settings.seed)) } : {}),
  };
  const endpoint = appendPath(baseUrl(input.config, input.format), "images/generations");
  return { url: endpoint, init: jsonRequest(endpoint, body, authHeaders(input.apiKey), input.signal) };
}

function buildSeedreamRequest(input: ImageGenerationRequest): { url: string; init: RequestInit } {
  const settings = imageSettings(input.config);
  const responseFormat = stringValue(settings.responseFormat) ?? "url";
  const references = imageAttachments(input.attachments).map((attachment) => attachment.data);
  const body: RecordValue = {
    model: input.config.model,
    prompt: promptText(input.prompt),
    ...(references.length ? { image: references.length === 1 ? references[0] : references } : {}),
    ...(stringValue(settings.size) && settings.size !== "auto" ? { size: settings.size } : {}),
    ...(stringValue(settings.sequentialImageGeneration) && settings.sequentialImageGeneration !== "disabled" ? { sequential_image_generation: settings.sequentialImageGeneration } : {}),
    ...(typeof settings.watermark === "boolean" ? { watermark: settings.watermark } : {}),
    response_format: responseFormat,
    ...(numberValue(settings.n) !== undefined && Number(settings.n) > 1 ? { n: Math.floor(Number(settings.n)) } : {}),
  };
  const endpoint = appendPath(baseUrl(input.config, input.format), "images/generations");
  return { url: endpoint, init: jsonRequest(endpoint, body, authHeaders(input.apiKey), input.signal) };
}

export function buildImageGenerationRequest(input: ImageGenerationRequest): { url: string; init: RequestInit } {
  if (input.format === "openai-image") return buildOpenAiRequest(input);
  if (input.format === "gemini-image") return buildGeminiRequest(input);
  if (input.format === "qwen-image") return buildQwenRequest(input);
  return buildSeedreamRequest(input);
}

function imageMime(outputFormat: string): string {
  return outputFormat === "jpeg" ? "image/jpeg" : outputFormat === "webp" ? "image/webp" : "image/png";
}

function imagePart(value: unknown, filename: string | undefined, index: number, fallbackMime: string): GeneratedImagePart | undefined {
  const source = record(value);
  if (!source) return undefined;
  const b64 = stringValue(source.b64_json ?? source.b64Json ?? source.base64);
  const url = stringValue(source.url ?? source.image_url ?? source.imageUrl ?? source.image);
  const inline = record(source.inlineData ?? source.inline_data);
  const inlineData = stringValue(inline?.data ?? source.data);
  const mime = stringValue(inline?.mimeType ?? inline?.mime_type) ?? fallbackMime;
  if (b64) return { type: "image", image: `data:${mime};base64,${b64}`, filename: filename ?? `generated-${index + 1}.png` };
  if (inlineData) return { type: "image", image: `data:${mime};base64,${inlineData}`, filename: filename ?? `generated-${index + 1}.png` };
  if (url) return { type: "image", image: url, filename };
  return undefined;
}

export function parseImageGenerationResponse(payload: unknown, format: ImageApiFormat, outputFormat = "png"): GeneratedImagePart[] {
  const root = record(payload);
  if (!root) return [];
  const parts: GeneratedImagePart[] = [];
  const fallbackMime = imageMime(outputFormat);
  const seen = new Set<string>();
  const addImage = (value: unknown, index: number) => {
    const part = imagePart(value, `generated-${index + 1}.${outputFormat}`, index, fallbackMime);
    if (!part || part.type !== "image" || seen.has(part.image)) return;
    seen.add(part.image);
    parts.push(part);
  };
  const addText = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || seen.has(`text:${value}`)) return;
    seen.add(`text:${value}`);
    parts.push({ type: "text", text: value });
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 8) return;
    const source = record(value);
    if (!source) return;
    if (format === "gemini-image") {
      addText(source.text);
      if (source.inlineData || source.inline_data) addImage(source, parts.length);
      if (source.type === "image" && stringValue(source.data)) addImage({ inline_data: { data: source.data, mime_type: source.mime_type ?? source.mimeType } }, parts.length);
      if (source.output_image) addImage(source.output_image, parts.length);
      if (record(source.image)) addImage(source.image, parts.length);
    }
    if (source.b64_json || source.b64Json || source.base64 || source.url || source.image_url || source.imageUrl || stringValue(source.image)) addImage(source, parts.length);
    if (record(source.image)) addImage(source.image, parts.length);
    for (const [key, child] of Object.entries(source)) {
      if (key === "task_id" || key === "task_status" || key === "request_id") continue;
      if (Array.isArray(child)) child.forEach((item) => walk(item, depth + 1));
      else if (record(child)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return parts;
}

async function responseError(response: Response): Promise<never> {
  const detail = (await response.text()).slice(0, 2_000);
  throw new Error(`Image API HTTP ${response.status}: ${detail}`);
}

async function pollDashScope(responsePayload: unknown, input: ImageGenerationRequest, fetchImpl: typeof fetch): Promise<unknown> {
  const root = record(responsePayload);
  const output = record(root?.output);
  const taskId = stringValue(output?.task_id ?? root?.task_id);
  if (!taskId) return responsePayload;
  const endpoint = appendPath(dashScopeEndpoint(input.config, true).replace(/\/services\/aigc\/image-generation\/generation$/, "/tasks"), taskId);
  for (let attempt = 0; attempt < 120; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const response = await fetchImpl(endpoint, { headers: authHeaders(input.apiKey), signal: input.signal });
    if (!response.ok) await responseError(response);
    const payload = await response.json() as unknown;
    const taskOutput = record(record(payload)?.output);
    const status = String(taskOutput?.task_status ?? "").toUpperCase();
    if (!status || ["SUCCEEDED", "FAILED", "CANCELED", "CANCELLED"].includes(status)) {
      if (["FAILED", "CANCELED", "CANCELLED"].includes(status)) throw new Error(`Qwen image task ${status.toLowerCase()}`);
      return payload;
    }
  }
  throw new Error("Qwen image task timed out");
}

export async function generateImage(input: ImageGenerationRequest): Promise<GeneratedImagePart[]> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const request = buildImageGenerationRequest(input);
  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) await responseError(response);
  let payload = await response.json() as unknown;
  if (input.format === "qwen-image" && qwenDashScope(input) && (imageSettings(input.config).async === true || imageSettings(input.config).asynchronous === true)) payload = await pollDashScope(payload, input, fetchImpl);
  const settings = imageSettings(input.config);
  const outputFormat = stringValue(settings.outputFormat) ?? "png";
  const parts = parseImageGenerationResponse(payload, input.format, outputFormat);
  if (!parts.some((part) => part.type === "image")) throw new Error("Image API returned no image data");
  return parts;
}
