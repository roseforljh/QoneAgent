import { describe, expect, test } from "bun:test";
import { Check } from "typebox/value";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CAPABILITY_IDS } from "@qone/protocol";
import { PiAdapter } from "../src/pi-adapter";
import { normalizeSubagentConfig, subagentCatalog } from "../src/subagents";

const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;

describe("model-facing subagent routing contract", () => {
  for (const api of ["openai-responses", "openai-codex-responses"] as const) {
    test(`${api} exposes an explicit temporary target and valid neutral values when fields are required`, async () => {
      const faux = fauxProvider({ provider: `routing-${api}`, models: [{ id: "model" }] });
      const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
      runtime.registerNativeProvider(faux.provider);
      let captured: any;
      faux.setResponses([async context => {
        const model = { ...faux.getModel(), api, baseUrl: api === "openai-responses" ? "https://example.test/v1" : "https://chatgpt.com/backend-api" };
        const options = {
          apiKey: api === "openai-responses" ? "test-key" : token,
          onPayload: (payload: unknown) => { captured = payload; throw new Error("capture only; no network request"); },
        };
        const stream = api === "openai-responses" ? streamResponses(model as never, context, options) : streamCodex(model as never, context, options);
        await stream.result();
        return fauxAssistantMessage(fauxText("ok"));
      }]);
      const adapter = new PiAdapter(() => {});
      (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
      adapter.setSubagentDispatcher(async () => "unused");
      const catalog = subagentCatalog(normalizeSubagentConfig({ runtime: { temporaryModelId: "provider/general" } }));
      adapter.setSubagentController({ catalog: () => catalog, list: () => [] } as never);
      const sessionId = `routing-${api}`;
      try {
        await adapter.run(sessionId, "审查代码", { cwd: process.cwd(), model: `${faux.provider.id}/model`, permissionMode: "full" }, () => {});
        const tool = captured.tools.find((tool: any) => tool.name === "dispatch_subagent");
        expect(tool.description).toContain('capability="temporary"');
        expect(tool.description).toContain("temporary general agent");
        expect(tool.description).toContain("Choose a media capability only");
        expect(tool.parameters.required).toEqual(["title", "task"]);
        const choices = tool.parameters.properties.capability.anyOf;
        expect(choices.filter((option: any) => option.const).map((option: any) => option.const)).toEqual(["temporary", ...CAPABILITY_IDS]);
        expect(choices.some((option: any) => option.type === "null")).toBe(true);
        expect(tool.parameters.properties.capability.default).toBeUndefined();
        expect(Check(tool.parameters, { title: "审查", task: "review" })).toBe(true);
        // Some gateways require every declared field. The captured wire schema must
        // still offer a general-agent route rather than force a media enum choice.
        const requiredSchema = { ...tool.parameters, required: Object.keys(tool.parameters.properties) };
        const fullArgs = { title: "审查", task: "review", capability: "temporary", subagentId: null, mediaPath: "", background: true };
        expect(Check(requiredSchema, fullArgs)).toBe(true);
        expect(Check(requiredSchema, { ...fullArgs, capability: null, subagentId: "reviewer" })).toBe(true);
        const workflow = captured.tools.find((tool: any) => tool.name === "run_subagent_workflow");
        const step = workflow.parameters.properties.steps.items;
        expect(step.properties.capability).toEqual(tool.parameters.properties.capability);
        expect(Check(step, { id: "review", title: "审查", task: "review", ...catalog.temporary.selection, subagentId: null, dependsOn: [] })).toBe(true);
        expect(captured.tools.find((tool: any) => tool.name === "list_subagents").description).toContain("temporary target is the default");
      } finally { await adapter.disposeSession(sessionId); }
    });
  }

  test("Pi executes explicit temporary and nullable profile selections without substituting a media target", async () => {
    const faux = fauxProvider({ provider: "routing-execution", models: [{ id: "model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const inputs: unknown[] = [];
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("dispatch_subagent", { title: "审查", task: "review", capability: "temporary", subagentId: null, mediaPath: "", background: true })),
      fauxAssistantMessage(fauxToolCall("dispatch_subagent", { title: "审查", task: "review", capability: null, subagentId: "reviewer", mediaPath: "", background: true })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const adapter = new PiAdapter(() => {});
    (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
    adapter.setSubagentDispatcher(async input => { inputs.push(input); return "started"; });
    try {
      await adapter.run("routing-execution", "审查", { runId: "parent-run", cwd: process.cwd(), model: "routing-execution/model", permissionMode: "full" }, () => {});
      expect(inputs).toHaveLength(2);
      expect(inputs[0]).toMatchObject({ capability: "temporary", subagentId: null, fallbackModel: "routing-execution/model", parentRunId: "parent-run" });
      expect(inputs[1]).toMatchObject({ capability: null, subagentId: "reviewer" });
    } finally { await adapter.disposeSession("routing-execution"); }
  });
});
