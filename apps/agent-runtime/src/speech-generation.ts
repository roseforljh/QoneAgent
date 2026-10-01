import { runtimeError } from "./runtime-localization";
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
    throw runtimeError("speech-generation.gemini_speech_api_returned_no_valid_audio_data", {});
  }
  const mimeType = audio.mime_type ?? audio.mimeType;
  if (mimeType && mimeType !== "audio/wav" && mimeType !== "audio/x-wav") {
    throw runtimeError("speech-generation.gemini_speech_api_returned_an_unsupported_audio_format", { p0: String(mimeType) });
  }
  const bytes = Buffer.from(audio.data, "base64");
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw runtimeError("speech-generation.audio_returned_by_the_gemini_speech_api_has_no", {});
  }
  return bytes;
}

/** The standard OpenAI-compatible text-to-speech wire format. */
export async function generateSpeech(input: SpeechGenerationRequest): Promise<GeneratedSpeech> {
  if (!input.text.trim()) throw runtimeError("speech-generation.speech_generation_requires_text_to_read_aloud", {});
  const settings = input.config.config as Record<string, unknown>;
  if (settings.apiType !== "openai-compatible" && settings.apiType !== "google") {
    throw runtimeError("speech-generation.the_current_api_format_does_not_support_speech_generation", {});
  }
  const speechSettings = settings.speechGeneration && typeof settings.speechGeneration === "object"
    ? settings.speechGeneration as Record<string, unknown> : {};
  const voice = typeof speechSettings.voice === "string" ? speechSettings.voice.trim() : "";
  if (!voice) throw runtimeError("speech-generation.speech_generation_requires_a_voice_in_the_model_parameters", {});
  const base = modelBaseUrl(settings.apiType, String(settings.baseUrl ?? ""));
  if (!base) throw runtimeError("speech-generation.the_speech_generation_model_has_no_api_url", {});
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
    if (!response.ok) throw runtimeError("speech-generation.gemini_speech_api_http", { p0: response.status, p1: (await response.text()).slice(0, 2_000) });
    return { bytes: googleAudio(await response.json()), mimeType: "audio/wav", extension: "wav" };
  }
  url.pathname = `${url.pathname.replace(/\/(?:audio\/speech)\/?$/i, "").replace(/\/+$/, "")}/audio/speech`;
  const response = await (input.fetchImpl ?? fetch)(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ model: input.config.model, input: input.text, voice, response_format: "mp3" }),
    signal: input.signal,
  });
  if (!response.ok) throw runtimeError("speech-generation.speech_generation_api_http", { p0: response.status, p1: (await response.text()).slice(0, 2_000) });
  if (/^(?:application\/json|text\/)/i.test(response.headers.get("content-type") ?? "")) {
    throw runtimeError("speech-generation.speech_generation_api_returned_no_audio", { p0: (await response.text()).slice(0, 2_000) });
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw runtimeError("speech-generation.speech_generation_api_returned_no_audio_data", {});
  const returnedMime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (returnedMime === "audio/wav" || returnedMime === "audio/x-wav") {
    return { bytes, mimeType: "audio/wav", extension: "wav" };
  }
  if (returnedMime && returnedMime !== "audio/mpeg" && returnedMime !== "audio/mp3" && returnedMime !== "application/octet-stream") {
    throw runtimeError("speech-generation.speech_generation_api_returned_an_unsupported_audio_format", { p0: returnedMime });
  }
  return { bytes, mimeType: "audio/mpeg", extension: "mp3" };
}
