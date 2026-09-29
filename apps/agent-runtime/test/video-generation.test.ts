import { expect, test } from "bun:test";
import type { ModelConfigInfo } from "@qone/protocol";
import { generateVideo } from "../src/video-generation";
import { PiAdapter } from "../src/pi-adapter";

const config = (baseUrl: string): ModelConfigInfo => ({
  id: "video/model", provider: "video", model: "model", enabled: true, updatedAt: 0,
  config: { apiType: "openai-compatible", baseUrl, autoMetadata: false, output: ["video"], videoGeneration: { format: "openai-videos" } },
});

const googleConfig = (baseUrl: string): ModelConfigInfo => ({
  id: "google/veo-3.1-generate-preview", provider: "google", model: "veo-3.1-generate-preview",
  enabled: true, updatedAt: 0,
  config: { apiType: "google", baseUrl, autoMetadata: false, output: ["video"] },
});

test("Google native Veo creates, polls, follows download redirect and keeps the API key on its own origin", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return Response.json({ name: "models/veo-3.1-generate-preview/operations/op-1" });
    if (calls.length === 2) return Response.json({ done: true, response: {
      generateVideoResponse: { generatedSamples: [{ video: { uri: "https://api.example/v1beta/files/file-1:download" } }] },
    } });
    if (calls.length === 3) return new Response(null, { status: 302, headers: { Location: "https://cdn.example/video.mp4" } });
    return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "Content-Type": "video/mp4" } });
  };
  const video = await generateVideo({ config: googleConfig("https://api.example/v1beta"), prompt: "A waterfall", apiKey: "test-key",
    signal: new AbortController().signal, fetchImpl, pollIntervalMs: 0 });
  expect(new Uint8Array(await new Response(video.stream).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
  expect(calls.map((call) => call.url)).toEqual([
    "https://api.example/v1beta/models/veo-3.1-generate-preview:predictLongRunning",
    "https://api.example/v1beta/models/veo-3.1-generate-preview/operations/op-1",
    "https://api.example/v1beta/files/file-1:download", "https://cdn.example/video.mp4",
  ]);
  expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ instances: [{ prompt: "A waterfall" }] });
  expect(calls[0]?.init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
  expect(calls[2]?.init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
  expect(calls[3]?.init?.headers).toBeUndefined();
});

test("Google native Veo reports operation errors and cancellation", async () => {
  const model = googleConfig("https://api.example/v1beta");
  await expect(generateVideo({ config: model, prompt: "clip", apiKey: "key", signal: new AbortController().signal,
    fetchImpl: async () => Response.json({ name: "operations/op-1", done: true, error: { message: "quota exhausted" } }),
  })).rejects.toThrow("quota exhausted");
  const controller = new AbortController();
  controller.abort();
  await expect(generateVideo({ config: model, prompt: "clip", apiKey: "key", signal: controller.signal,
    fetchImpl: async () => Response.json({ name: "operations/op-1" }), pollIntervalMs: 0,
  })).rejects.toThrow();
});

test("Sora-compatible video transport creates, polls and downloads without leaking auth to the media URL", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return Response.json({ id: "op-1", status: "processing" });
    if (calls.length === 2) return Response.json({ id: "op-1", status: "completed", url: "https://cdn.example/video.mp4" });
    return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "Content-Type": "video/mp4" } });
  };
  const video = await generateVideo({ config: config("https://gateway.example/v1"), prompt: "A waterfall", apiKey: "test-key", signal: new AbortController().signal, fetchImpl, pollIntervalMs: 0 });
  expect(new Uint8Array(await new Response(video.stream).arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
  expect(video.mimeType).toBe("video/mp4");
  expect(calls.map((call) => call.url)).toEqual(["https://gateway.example/v1/videos", "https://gateway.example/v1/videos/op-1", "https://cdn.example/video.mp4"]);
  expect((calls[0]?.init?.body as FormData).get("model")).toBe("model");
  expect((calls[0]?.init?.body as FormData).get("prompt")).toBe("A waterfall");
  expect(calls[2]?.init?.headers).toBeUndefined();
});

test("video transport reports provider failure and requires an explicit format", async () => {
  const model = config("https://gateway.example/v1");
  const signal = new AbortController().signal;
  model.config.videoGeneration = {};
  await expect(generateVideo({ config: model, prompt: "clip", apiKey: "key", signal })).rejects.toThrow("接口格式");
  model.config.videoGeneration = { format: "openai-videos" };
  await expect(generateVideo({ config: model, prompt: "clip", apiKey: "key", signal, pollIntervalMs: 0,
    fetchImpl: async () => Response.json({ id: "op-1", status: "failed", error: { message: "quota exhausted" } }),
  })).rejects.toThrow("quota exhausted");
});

test("a video-output model completes a Pi run with a streamed generated file", async () => {
  let baseUrl = "";
  const server = Bun.serve({ port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/v1/videos" && request.method === "POST") return Response.json({ id: "op-1", status: "completed", url: `${baseUrl}/generated.mp4` });
    if (pathname === "/generated.mp4") return new Response(new Uint8Array([0, 1, 2, 3]), { headers: { "Content-Type": "video/mp4" } });
    return Response.json({ data: [] });
  } });
  baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    let saved: Uint8Array | undefined;
    const events: Array<{ type: string; payload: unknown }> = [];
    const adapter = new PiAdapter((event) => events.push(event), {
      onGeneratedMedia: async (_sessionId, _runId, data) => {
        saved = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
        return "C:\\media\\video.mp4";
      },
    });
    const model = config(`${baseUrl}/v1`);
    await adapter.setSecret("model.apiKey:video", "test-key");
    await adapter.configureModels([model]);
    expect(adapter.isDirectGenerationModel(model.id)).toBe(true);
    await adapter.run("session", "A waterfall", { model: model.id, runId: "run-video" }, () => {});
    expect(saved).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(events.some((event) => event.type === "message.completed" && JSON.stringify(event.payload).includes("video.mp4"))).toBe(true);
  } finally {
    server.stop();
  }
});

test("a Google video-output model uses native Veo and persists the generated video", async () => {
  let baseUrl = "";
  const requests: string[] = [];
  const server = Bun.serve({ port: 0, fetch(request) {
    const pathname = new URL(request.url).pathname;
    requests.push(`${request.method} ${pathname}`);
    if (pathname.endsWith(":predictLongRunning")) return Response.json({ name: "operations/op-1", done: true,
      response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${baseUrl}/v1beta/files/video-1:download` } }] } } });
    if (pathname === "/v1beta/files/video-1:download") return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "video/mp4" } });
    return Response.json({ data: [] });
  } });
  baseUrl = `http://127.0.0.1:${server.port}`;
  try {
    let saved: Uint8Array | undefined;
    const adapter = new PiAdapter(() => {}, { onGeneratedMedia: async (_sessionId, _runId, data) => {
      saved = data instanceof Uint8Array ? data : new Uint8Array(await new Response(data).arrayBuffer());
      return "C:\\media\\veo.mp4";
    } });
    const model = googleConfig(`${baseUrl}/v1beta`);
    await adapter.setSecret("model.apiKey:google", "test-key");
    await adapter.configureModels([model]);
    await adapter.run("session", "A waterfall", { model: model.id, runId: "run-veo" }, () => {});
    expect(saved).toEqual(new Uint8Array([1, 2, 3]));
    expect(requests).toContain("POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning");
    expect(requests).toContain("GET /v1beta/files/video-1:download");
  } finally {
    server.stop();
  }
});
