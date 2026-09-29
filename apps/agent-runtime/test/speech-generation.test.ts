import { expect, test } from "bun:test";
import type { ModelConfigInfo } from "@qone/protocol";
import { generateSpeech } from "../src/speech-generation";
import { PiAdapter } from "../src/pi-adapter";

const config = (baseUrl: string, voice?: string): ModelConfigInfo => ({
  id: "speech/model", provider: "speech", model: "model", enabled: true, updatedAt: 0,
  config: { apiType: "openai-compatible", baseUrl, output: ["audio"], speechGeneration: { voice } },
});

test("speech generation sends the configured voice and exact text to the compatible API", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const bytes = new Uint8Array([73, 68, 51, 1]);
  const result = await generateSpeech({
    config: config("https://gateway.example/v1", "custom-voice"), text: "你好，世界", apiKey: "test-key", signal: new AbortController().signal,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init: init! };
      return new Response(bytes, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    },
  });
  expect(result).toEqual({ bytes, mimeType: "audio/mpeg", extension: "mp3" });
  expect(request?.url).toBe("https://gateway.example/v1/audio/speech");
  expect(request?.init.headers).toEqual({ Authorization: "Bearer test-key", "Content-Type": "application/json", Accept: "audio/mpeg" });
  expect(JSON.parse(String(request?.init.body))).toEqual({ model: "model", input: "你好，世界", voice: "custom-voice", response_format: "mp3" });
});

test("Gemini native speech sends an interaction and saves the returned WAV", async () => {
  const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(32)]);
  const model = config("https://generativelanguage.googleapis.com/v1beta", "Kore");
  model.config.apiType = "google";
  let request: { url: string; init: RequestInit } | undefined;
  const speech = await generateSpeech({ config: model, text: "你好", apiKey: "google-key", signal: new AbortController().signal,
    fetchImpl: async (url, init) => {
      request = { url: String(url), init: init! };
      return Response.json({ steps: [{ type: "model_output", content: [{ type: "audio", data: wav.toString("base64") }] }] });
    },
  });
  expect(speech).toEqual({ bytes: wav, mimeType: "audio/wav", extension: "wav" });
  expect(request?.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
  expect(JSON.parse(String(request?.init.body))).toEqual({ model: "model", input: [{ type: "user_input", content: [{ type: "text", text: "你好" }] }], response_format: { type: "audio" }, generation_config: { speech_config: [{ voice: "Kore" }] } });
});

test("speech generation reports API errors and missing voice", async () => {
  const signal = new AbortController().signal;
  expect(generateSpeech({ config: config("https://gateway.example/v1"), text: "Hello", apiKey: "key", signal })).rejects.toThrow("voice");
  expect(generateSpeech({ config: config("https://gateway.example/v1", "voice"), text: "Hello", apiKey: "key", signal,
    fetchImpl: async () => new Response('{"error":"unsupported voice"}', { status: 400 }),
  })).rejects.toThrow("unsupported voice");
  expect(generateSpeech({ config: config("https://gateway.example/v1", "voice"), text: "Hello", apiKey: "key", signal,
    fetchImpl: async () => Response.json({ error: "model returned text" }),
  })).rejects.toThrow("model returned text");
});

test("speech output keeps the provider's WAV media type when it differs from the requested MP3", async () => {
  const bytes = new Uint8Array([82, 73, 70, 70]);
  const speech = await generateSpeech({ config: config("https://gateway.example/v1", "voice"), text: "Hello", apiKey: "key", signal: new AbortController().signal,
    fetchImpl: async () => new Response(bytes, { headers: { "Content-Type": "audio/wav" } }),
  });
  expect(speech).toEqual({ bytes, mimeType: "audio/wav", extension: "wav" });
});

test("an audio-output model completes a Pi run and yields a saved media reference", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname.endsWith("/audio/speech")) return new Response(new Uint8Array([73, 68, 51, 1]), { headers: { "Content-Type": "audio/mpeg" } });
    return Response.json({ data: [] });
  } });
  try {
    const events: Array<{ type: string; payload: unknown }> = [];
    let saved: Uint8Array | undefined;
    const adapter = new PiAdapter((event) => events.push(event), {
      onGeneratedMedia: async (_sessionId, _runId, bytes) => { saved = bytes; return "C:\\media\\speech.mp3"; },
    });
    const model = config(`http://127.0.0.1:${server.port}/v1`, "voice");
    model.config.autoMetadata = false;
    await adapter.setSecret("model.apiKey:speech", "test-key");
    await adapter.configureModels([model]);
    expect(adapter.isDirectGenerationModel(model.id)).toBe(true);
    await adapter.run("session-1", "Read exactly this", { model: model.id, runId: "run-1" }, () => {});
    expect(saved).toEqual(new Uint8Array([73, 68, 51, 1]));
    expect(events.some((event) => event.type === "message.completed" && JSON.stringify(event.payload).includes("speech.mp3"))).toBe(true);
  } finally {
    server.stop();
  }
});

test("stopping speech generation aborts its request before a file is saved", async () => {
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/audio/speech")) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return new Response(new Uint8Array([73, 68, 51]));
    }
    return Response.json({ data: [] });
  } });
  try {
    let saved = false;
    const adapter = new PiAdapter(() => {}, { onGeneratedMedia: async () => { saved = true; return "file"; } });
    const model = config(`http://127.0.0.1:${server.port}/v1`, "voice");
    model.config.autoMetadata = false;
    await adapter.setSecret("model.apiKey:speech", "test-key");
    await adapter.configureModels([model]);
    const run = adapter.run("session-1", "Read", { model: model.id, runId: "run-2" }, () => {});
    expect(adapter.stop("run-2")).toBe(true);
    await expect(run).rejects.toThrow();
    expect(saved).toBe(false);
  } finally {
    server.stop();
  }
});
