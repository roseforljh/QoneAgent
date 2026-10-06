import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { PiAdapter } from "../src/pi-adapter";
import { readSystemPrompt } from "../src/system-prompt";
import { DouyinBridge } from "../src/douyin-bridge";

test("model-facing system text starts with the same eight modules across model/tool/workspace/context changes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-prompt-runtime-"));
  const originalRoot = process.env.QONE_DATA_DIR;
  process.env.QONE_DATA_DIR = path.join(root, "data");
  const faux = fauxProvider({ provider: "qone-prompt-test", models: [{ id: "first" }, { id: "second" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, {
    webAccessContext: () => "[QONE_WEB_ACCESS_MEMORY]\nexample.com: web_fetch failed (timeout); prefer OpenCLI Browser Bridge\n[/QONE_WEB_ACCESS_MEMORY]",
  });
  Object.assign(adapter, { modelRuntime: runtime });
  const systemTexts: string[] = [];
  const fixed = readSystemPrompt();
  try {
    for (const [index, modelId] of ["first", "second"].entries()) {
      const workspace = path.join(root, `workspace-${index}`);
      mkdirSync(workspace);
      writeFileSync(path.join(workspace, "AGENTS.md"), `PROJECT_CONTEXT_${index}`);
      writeFileSync(path.join(process.env.QONE_DATA_DIR!, "Qone.md"), `USER_CONTEXT_${index}`);
      await adapter.setCustomTools(index ? [{
        name: "qone_prompt_probe", label: "Prompt probe", description: "A changed runtime tool.",
        promptSnippet: "TOOL_CONTEXT_SECOND", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
      }] : []);
      faux.setResponses([async (context) => {
        let payload: any;
        const model = { ...faux.getModel(), api: "openai-responses", baseUrl: "https://example.test/v1" };
        await streamResponses(model as never, context, {
          apiKey: "test-key",
          onPayload: (value) => { payload = value; throw new Error("Capture payload before network access"); },
        }).result();
        const system = payload.input.find((message: any) => message.role === "developer" || message.role === "system");
        const text = typeof system.content === "string" ? system.content : system.content.map((part: any) => part.text).join("\n");
        systemTexts.push(text);
        expect(text.startsWith(fixed)).toBe(true);
        expect(text).toContain(`USER_CONTEXT_${index}`);
        expect(text).toContain(`PROJECT_CONTEXT_${index}`);
        expect(text).toContain(workspace.replace(/\\/g, "/"));
        expect(text).not.toContain("You are an expert coding assistant operating inside pi");
        expect(text).not.toContain("Qone 工作原则");
        expect(JSON.stringify(payload.input)).toContain("QONE_WEB_ACCESS_MEMORY");
        if (index) expect(text.slice(fixed.length)).toContain("TOOL_CONTEXT_SECOND");
        return fauxAssistantMessage(fauxText("Checked."));
      }]);
      await adapter.run(`session-${index}`, `TASK_CONTEXT_${index}`, { cwd: workspace, model: `${faux.provider.id}/${modelId}`, permissionMode: "full" }, () => {});
      await adapter.disposeSession(`session-${index}`);
    }
    expect(systemTexts).toHaveLength(2);
    expect(systemTexts[0]!.slice(0, fixed.length)).toBe(systemTexts[1]!.slice(0, fixed.length));
    expect(systemTexts[0]).not.toBe(systemTexts[1]);
  } finally {
    for (const id of ["session-0", "session-1"]) await adapter.disposeSession(id);
    if (originalRoot === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = originalRoot;
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error("Unsafe test cleanup");
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("existing custom prompts still receive embedded Douyin routing and all three tools", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-douyin-routing-"));
  const originalRoot = process.env.QONE_DATA_DIR;
  process.env.QONE_DATA_DIR = path.join(root, "data");
  const faux = fauxProvider({ provider: "qone-douyin-routing", models: [{ id: "text-model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, {}, undefined, undefined, undefined, new DouyinBridge(() => {
    throw new Error("This test must not request a browser");
  }));
  Object.assign(adapter, { modelRuntime: runtime });
  let requests = 0;
  try {
    readSystemPrompt();
    writeFileSync(path.join(process.env.QONE_DATA_DIR, "system-prompts", "04-web-access.md"), "# Custom web policy\n\nUse the available session tools.");
    faux.setResponses([async (context) => {
      requests++;
      const session = (adapter as unknown as { sessions: Map<string, { getCallableToolNames: () => string[] }> }).sessions.get("route-check");
      const names = session!.getCallableToolNames();
      expect(names).toContain("qone_douyin_resolve_author");
      expect(names).toContain("qone_douyin_list_videos");
      expect(names).toContain("qone_douyin_download");
      // Provider contexts normalize system text/tool declarations into messages.
      expect(JSON.stringify(context.messages)).toContain("Custom web policy");
      expect(JSON.stringify(context.messages)).toContain("QONE_DOUYIN_ROUTING");
      expect(JSON.stringify(context.messages)).toContain("Do not pre-open Douyin");
      return fauxAssistantMessage(fauxText("Route checked."));
    }]);
    await adapter.run("route-check", "下载这个分享视频所属博主前10个视频：https://v.douyin.com/share/", {
      cwd: root, model: `${faux.provider.id}/text-model`, permissionMode: "full",
    }, () => {});
    expect(requests).toBe(1);
  } finally {
    await adapter.disposeSession("route-check");
    if (originalRoot === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = originalRoot;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
