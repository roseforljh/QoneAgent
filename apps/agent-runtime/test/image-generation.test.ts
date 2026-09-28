import { describe, expect, test } from "bun:test";
import { buildImageGenerationRequest, generateImage, parseImageGenerationResponse } from "../src/image-generation.js";
import { detectImageModel, imageApiFormatForModelName, isGeminiImageModelName, isQwenImageModelName, isSeedreamModelName, parseModelMetadata, type ModelConfigInfo } from "@qone/protocol";

function config(model: string, provider: string, baseUrl: string, extra: Record<string, unknown> = {}): ModelConfigInfo {
  return { id: `${provider}/${model}`, provider, model, config: { baseUrl, apiType: "openai-compatible", ...extra }, enabled: true, updatedAt: 0 };
}

describe("image model detection", () => {
  test("recognizes the four image model families without version hardcoding", () => {
    expect(imageApiFormatForModelName("gpt-image-2.5-flare")).toBe("openai-image");
    expect(isGeminiImageModelName("google/nano-banana-pro")).toBe(true);
    expect(isQwenImageModelName("qwen-image-3-pro")).toBe(true);
    expect(isSeedreamModelName("doubao-seedream-6")).toBe(true);
  });

  test("manual format and image output take priority over name fallback", () => {
    expect(detectImageModel({ model: "gpt-image-custom", provider: "qwen", imageApiFormat: "qwen-image" })).toMatchObject({ isImageModel: true, format: "qwen-image", source: "manual-format" });
    expect(detectImageModel({ model: "gpt-image-2.5", provider: "qwen", apiType: "codex", output: ["text", "image"], manualOutput: true })).toMatchObject({ isImageModel: true, format: "openai-image" });
    expect(detectImageModel({ model: "unknown", provider: "custom", output: ["image"] })).toMatchObject({ isImageModel: true, format: "openai-image", source: "manual-capability" });
    expect(detectImageModel({ model: "unknown", metadata: { output: ["image"], imageApiFormat: "seedream-image" } })).toMatchObject({ isImageModel: true, format: "seedream-image", source: "metadata" });
    expect(detectImageModel({ model: "unknown", provider: "volcengine", metadata: { supportedMethods: ["images.generations"] } })).toMatchObject({ isImageModel: true, format: "seedream-image", source: "metadata" });
    expect(detectImageModel({ model: "gpt-image-new", output: ["text"], manualOutput: true, metadata: { output: ["image"] } }).isImageModel).toBe(false);
    expect(detectImageModel({ model: "gpt-image-new", output: ["image"], metadata: { output: ["text"] } }).isImageModel).toBe(false);
    expect(detectImageModel({ model: "future-image", output: ["image"], manualOutput: true, imageApiFormat: "seedream-image" })).toMatchObject({ isImageModel: true, format: "seedream-image", source: "manual-capability" });
    expect(detectImageModel({ model: "chat-model", output: ["text"] }).isImageModel).toBe(false);
    expect(detectImageModel({ model: "gpt-4o", provider: "openai", apiType: "openai-compatible" }).isImageModel).toBe(false);
  });

  test("normalizes capability and method declarations from provider catalogs", () => {
    const metadata = parseModelMetadata({ id: "vendor-image", capabilities: ["image_generation"] });
    expect(metadata?.output).toEqual(["image"]);
    expect(metadata?.supportedMethods).toEqual(["image_generation"]);
  });
});

describe("image request formats", () => {
  test("executes each format adapter through its response parser", async () => {
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      if (String(url).includes("openai")) return Response.json({ data: [{ b64_json: "AAAA" }] });
      if (String(url).includes("google")) return Response.json({ output: [{ type: "image", mime_type: "image/png", data: "BBBB" }] });
      if (String(url).includes("qwen")) return Response.json({ output: { choices: [{ message: { content: [{ image: "https://qwen.test/image.png" }] } }] } });
      return Response.json({ data: [{ url: "https://seedream.test/image.png" }] });
    }) as typeof fetch;
    const results = await Promise.all([
      generateImage({ config: config("gpt-image-1", "openai", "https://openai.test/v1"), format: "openai-image", prompt: "a", apiKey: "key", signal, fetchImpl }),
      generateImage({ config: config("gemini-3.1-flash-image", "google", "https://google.test"), format: "gemini-image", prompt: "b", apiKey: "key", signal, fetchImpl }),
      generateImage({ config: config("qwen-image-3", "qwen", "https://qwen.test", { imageGeneration: { transport: "openai-compatible" } }), format: "qwen-image", prompt: "c", apiKey: "key", signal, fetchImpl }),
      generateImage({ config: config("seedream-5", "seedream", "https://seedream.test/api/v3"), format: "seedream-image", prompt: "d", apiKey: "key", signal, fetchImpl }),
    ]);
    expect(results.map((parts) => parts.find((part) => part.type === "image")?.image)).toEqual([
      "data:image/png;base64,AAAA", "data:image/png;base64,BBBB", "https://qwen.test/image.png", "https://seedream.test/image.png",
    ]);
    expect(calls).toHaveLength(4);
  });

  test("builds OpenAI generations and edits requests", async () => {
    const generated = buildImageGenerationRequest({ config: config("gpt-image-1", "openai", "https://api.openai.com/v1"), format: "openai-image", prompt: "cat", apiKey: "key", signal: new AbortController().signal });
    expect(generated.url).toBe("https://api.openai.com/v1/images/generations");
    expect(JSON.parse(String(generated.init.body))).toMatchObject({ model: "gpt-image-1", prompt: "cat" });
    const edited = buildImageGenerationRequest({ config: config("gpt-image-1", "openai", "https://api.openai.com/v1"), format: "openai-image", prompt: "edit", attachments: [{ type: "image", name: "ref.png", mimeType: "image/png", data: "data:image/png;base64,AAAA" }], apiKey: "key", signal: new AbortController().signal });
    expect(edited.url).toContain("/images/edits");
    expect(edited.init.body).toBeInstanceOf(FormData);
  });

  test("does not send GPT Image compression for PNG output", () => {
    const request = buildImageGenerationRequest({ config: config("gpt-image-2.5", "qwen", "https://gateway.test/v1", { imageGeneration: { outputFormat: "png", outputCompression: 50 } }), format: "openai-image", prompt: "cat", apiKey: "key", signal: new AbortController().signal });
    expect(JSON.parse(String(request.init.body))).not.toHaveProperty("output_compression");
  });

  test("keeps automatic count with the provider and sends compression for JPEG", () => {
    const input = { format: "openai-image" as const, prompt: "cat", apiKey: "key", signal: new AbortController().signal };
    const automatic = buildImageGenerationRequest({ ...input, config: config("gpt-image-2.5", "openai", "https://gateway.test/v1", { imageGeneration: { n: "auto", outputFormat: "jpeg", outputCompression: 65 } }) });
    expect(JSON.parse(String(automatic.init.body))).toMatchObject({ output_format: "jpeg", output_compression: 65 });
    expect(JSON.parse(String(automatic.init.body))).not.toHaveProperty("n");
    const manual = buildImageGenerationRequest({ ...input, config: config("gpt-image-2.5", "openai", "https://gateway.test/v1", { imageGeneration: { n: 3, outputFormat: "jpeg" } }) });
    expect(JSON.parse(String(manual.init.body))).toHaveProperty("n", 3);
  });

  test("passes prompt instructions unchanged while leaving automatic parameters to the image API", () => {
    const prompt = "请生成两张透明背景的方形猫咪图";
    const request = buildImageGenerationRequest({ config: config("gpt-image-2.5", "openai", "https://gateway.test/v1", { imageGeneration: { size: "auto", quality: "auto", background: "auto", n: "auto" } }), format: "openai-image", prompt, apiKey: "key", signal: new AbortController().signal });
    const body = JSON.parse(String(request.init.body));
    expect(body.prompt).toBe(prompt);
    for (const field of ["size", "quality", "background", "n"]) expect(body).not.toHaveProperty(field);
  });

  test("builds native Gemini Interactions request with image response settings", () => {
    const request = buildImageGenerationRequest({ config: config("gemini-3.1-flash-image", "google", "https://generativelanguage.googleapis.com", { apiType: "google", imageGeneration: { aspectRatio: "16:9", imageSize: "2K" } }), format: "gemini-image", prompt: "sunset", apiKey: "key", signal: new AbortController().signal });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(body.model).toBe("gemini-3.1-flash-image");
    expect(body.input).toEqual([{ type: "text", text: "sunset" }]);
    expect(body.response_format).toMatchObject({ type: "image", aspect_ratio: "16:9", image_size: "2K" });
  });

  test("keeps Qwen extension fields and DashScope protocol separate", () => {
    const request = buildImageGenerationRequest({ config: config("qwen-image-3", "qwen", "https://dashscope.aliyuncs.com", { imageGeneration: { transport: "dashscope", async: true, negativePrompt: "blur", promptExtend: true, enableThinking: false, watermark: false, seed: 7 } }), format: "qwen-image", prompt: "mountain", apiKey: "key", signal: new AbortController().signal });
    expect(request.url).toContain("/api/v1/services/aigc/image-generation/generation");
    expect(request.init.headers).toMatchObject({ "X-DashScope-Async": "enable" });
    expect(JSON.parse(String(request.init.body))).toMatchObject({ input: { messages: [{ content: [{ text: "mountain" }] }] }, parameters: { negative_prompt: "blur", prompt_extend: true, enable_thinking: false, seed: 7 } });
    const sync = buildImageGenerationRequest({ config: config("qwen-image-3", "qwen", "https://dashscope.aliyuncs.com", { imageGeneration: { transport: "dashscope" } }), format: "qwen-image", prompt: "mountain", apiKey: "key", signal: new AbortController().signal });
    expect(sync.url).toContain("/api/v1/services/aigc/multimodal-generation/generation");
    expect(sync.init.headers).not.toHaveProperty("X-DashScope-Async");
  });

  test("builds Seedream multi-image request and parses URL/base64/Gemini responses", () => {
    const request = buildImageGenerationRequest({ config: config("doubao-seedream-5", "volcengine", "https://ark.cn-beijing.volces.com/api/v3", { imageGeneration: { size: "2K", responseFormat: "b64_json", sequentialImageGeneration: "auto" } }), format: "seedream-image", prompt: "portrait", attachments: [{ type: "image", name: "a.png", mimeType: "image/png", data: "data:image/png;base64,AAAA" }, { type: "image", name: "b.png", mimeType: "image/png", data: "data:image/png;base64,BBBB" }], apiKey: "key", signal: new AbortController().signal });
    const body = JSON.parse(String(request.init.body));
    expect(request.url).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(body).toMatchObject({ size: "2K", response_format: "b64_json", sequential_image_generation: "auto" });
    expect(body.image).toHaveLength(2);
    expect(parseImageGenerationResponse({ data: [{ url: "https://img.test/a.png" }, { b64_json: "AAAA" }] }, "seedream-image")).toHaveLength(2);
    expect(parseImageGenerationResponse({ output: { choices: [{ message: { content: [{ image: "https://img.test/qwen.png" }] } }] } }, "qwen-image")[0]).toMatchObject({ image: "https://img.test/qwen.png" });
    expect(parseImageGenerationResponse({ data: [{ b64_json: "AAAA" }] }, "openai-image", "jpeg")[0]).toMatchObject({ image: "data:image/jpeg;base64,AAAA" });
    expect(parseImageGenerationResponse({ output: [{ type: "text", text: "done" }, { type: "image", mime_type: "image/png", data: "AAAA" }] }, "gemini-image")).toEqual([{ type: "text", text: "done" }, { type: "image", image: "data:image/png;base64,AAAA", filename: "generated-2.png" }]);
  });
});
