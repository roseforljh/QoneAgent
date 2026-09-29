import { expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiAdapter } from "../src/pi-adapter";

test("Responses delegation keeps media selection optional and describes the temporary general agent", async () => {
  const faux = fauxProvider({ provider: "routing-contract", models: [{ id: "model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  let captured: any;
  faux.setResponses([async context => {
    const stream = streamSimple({ ...faux.getModel(), api: "openai-responses", baseUrl: "https://example.test/v1" } as never, context, {
      apiKey: "test-key",
      onPayload: payload => { captured = payload; throw new Error("capture only; no network request"); },
    });
    await stream.result();
    return fauxAssistantMessage(fauxText("ok"));
  }]);
  const adapter = new PiAdapter(() => {});
  (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
  adapter.setSubagentDispatcher(async () => "unused");
  try {
    await adapter.run("routing-contract", "审查代码", { cwd: process.cwd(), model: "routing-contract/model", permissionMode: "full" }, () => {});
    const tool = captured.tools.find((tool: any) => tool.name === "dispatch_subagent");
    expect(tool.description).toContain("temporary general agent");
    expect(tool.description).toContain("Use capability only for a task that explicitly needs that named media ability");
    const catalogTool = captured.tools.find((tool: any) => tool.name === "list_subagents");
    expect(catalogTool.description).toContain("temporary target is the default");
    expect(tool.strict).toBeUndefined();
    expect(tool.parameters.required).toEqual(["title", "task"]);
    expect(tool.parameters.properties.capability.default).toBeUndefined();
    expect(tool.parameters.properties.capability.anyOf.map((option: any) => option.const)).toEqual([
      "videoRecognition", "imageGeneration", "videoGeneration", "stt", "tts",
    ]);
  } finally {
    await adapter.disposeSession("routing-contract");
  }
});
