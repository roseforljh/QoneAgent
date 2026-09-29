import { modelBaseUrl, type ModelConfigInfo } from "@qone/protocol";

export interface SpeechGenerationRequest {
  config: ModelConfigInfo;
  text: string;
  apiKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface GeneratedSpeech {
  bytes: Uint8Array;
  mimeType: "audio/mpeg" | "audio/wav";
  extension: "mp3" | "wav";
}

type AudioData = { type?: unknown; data?: unknown; mime_type?: unknown; mimeType?: unknown };

function googleAudio(payload: unknown): Uint8Array {
  const response = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const direct = response.output_audio && typeof response.output_audio === "object" ? response.output_audio as AudioData : undefined;
  const steps = Array.isArray(response.steps) ? response.steps : [];
  const parts = steps.flatMap((step) => step && typeof step === "object" && Array.isArray((step as { content?: unknown }).content)
    ? (step as { content: unknown[] }).content : []) as AudioData[];
  const audio = direct ?? [...parts].reverse().find((part) => part?.type === "audio");
  if (!audio || typeof audio.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio.data)) {
    throw new Error("Gemini 语音接口未返回有效音频数据");
  }
  const mimeType = audio.mime_type ?? audio.mimeType;
  if (mimeType && mimeType !== "audio/wav" && mimeType !== "audio/x-wav") {
    throw new Error(`Gemini 语音接口返回了未接入的音频格式：${String(mimeType)}`);
  }
  const bytes = Buffer.from(audio.data, "base64");
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Gemini 语音接口返回的音频缺少 WAV 文件头");
  }
  return bytes;
}

/** The standard OpenAI-compatible text-to-speech wire format. */
export async function generateSpeech(input: SpeechGenerationRequest): Promise<GeneratedSpeech> {
  if (!input.text.trim()) throw new Error("语音生成缺少待朗读文本");
  const settings = input.config.config as Record<string, unknown>;
  if (settings.apiType !== "openai-compatible" && settings.apiType !== "google") {
    throw new Error("当前 API 格式尚未接入语音生成接口");
  }
  const speechSettings = settings.speechGeneration && typeof settings.speechGeneration === "object"
    ? settings.speechGeneration as Record<string, unknown> : {};
  const voice = typeof speechSettings.voice === "string" ? speechSettings.voice.trim() : "";
  if (!voice) throw new Error("语音生成需要在模型参数中填写 voice");
  const base = modelBaseUrl(settings.apiType, String(settings.baseUrl ?? ""));
  if (!base) throw new Error("语音生成模型缺少 API 地址");
  const url = new URL(base);
  if (settings.apiType === "google") {
    url.pathname = `${url.pathname.replace(/\/interactions\/?$/i, "").replace(/\/+$/, "")}/interactions`;
    const response = await (input.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { "x-goog-api-key": input.apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ model: input.config.model,
        input: [{ type: "user_input", content: [{ type: "text", text: input.text }] }],
        response_format: { type: "audio" }, generation_config: { speech_config: [{ voice }] } }),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`Gemini 语音接口 HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
    return { bytes: googleAudio(await response.json()), mimeType: "audio/wav", extension: "wav" };
  }
  url.pathname = `${url.pathname.replace(/\/(?:audio\/speech)\/?$/i, "").replace(/\/+$/, "")}/audio/speech`;
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ model: input.config.model, input: input.text, voice, response_format: "mp3" }),
    signal: input.signal,
  });
  if (!response.ok) throw new Error(`语音生成接口 HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
  if (/^(?:application\/json|text\/)/i.test(response.headers.get("content-type") ?? "")) {
    throw new Error(`语音生成接口未返回音频：${(await response.text()).slice(0, 2_000)}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error("语音生成接口没有返回音频数据");
  const returnedMime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (returnedMime === "audio/wav" || returnedMime === "audio/x-wav") {
    return { bytes, mimeType: "audio/wav", extension: "wav" };
  }
  if (returnedMime && returnedMime !== "audio/mpeg" && returnedMime !== "audio/mp3" && returnedMime !== "application/octet-stream") {
    throw new Error(`语音生成接口返回了不支持的音频格式：${returnedMime}`);
  }
  return { bytes, mimeType: "audio/mpeg", extension: "mp3" };
}
