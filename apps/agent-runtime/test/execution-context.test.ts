import { expect, test } from "bun:test";
import { arch, hostname, release, type } from "node:os";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { executionContextExtension } from "../src/execution-context";
import { ServerService } from "../src/servers/server-service";

test("execution context uses the session cwd, actual local platform and supplied tool ownership", () => {
  let before!: (event: { systemPromptOptions: { cwd: string; sections: Record<string, string> } }) => void;
  const extension = executionContextExtension({ localTools: ["read", "custom-local-shell"], serverTools: ["remote-command"], servers: () => [] });
  extension({ on: (_name: string, callback: typeof before) => { before = callback; } } as unknown as Parameters<ExtensionFactory>[0]);
  const options = { cwd: "session-workspace", sections: { preamble: "keep user's custom prompt" } };
  before({ systemPromptOptions: options });
  const text = (options.sections as Record<string, string>).execution_environment!;
  const data = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  expect(data).toEqual({ local: { hostname: hostname(), platform: process.platform, system: type(), release: release(), architecture: arch(),
    cwd: "session-workspace", tools: ["read", "custom-local-shell"] }, servers: [], serverTools: ["remote-command"] });
  expect(options.sections.preamble).toBe("keep user's custom prompt");
  expect(text).toContain("ask one concise question");
  expect(text).toContain("Do not ask again when the target is already clear");
  expect(text).toContain("Enabling a server or granting full tool access does not select it");
  expect(text).toContain("Never silently rerun a failed remote operation locally");
});

test("server context projects only selected metadata and refreshes without exposing credentials", () => {
  const server = { id: "alpha", name: "Build host", host: "alpha.example", port: 2202, username: "builder", system: "Debian",
    status: "ready", auth: { kind: "key", keyPath: "SECRET_KEY_PATH", dedicated: true }, hostKey: "SECRET_HOST_KEY", createdAt: 0 };
  const values = new Map<string, unknown>([["servers.list", [server, { ...server, id: "foreign", host: "foreign.example" }]]]);
  const service = new ServerService({ get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, value) } as never, () => {}, async () => {});
  try {
    expect(service.executionTargets()).toEqual([]);
    expect(service.executionTargets(["missing"])).toEqual([]);
    expect(service.executionTargets(["alpha", "alpha", "missing"])).toEqual([{ id: "alpha", name: "Build host", host: "alpha.example", port: 2202,
      username: "builder", system: "Debian", lastKnownStatus: "ready" }]);
    expect(service.summary(["alpha"])).toContain("Build host");
    service.registry.update("alpha", { status: "offline", name: "Renamed host" });
    expect(service.executionTargets(["alpha"])[0]).toMatchObject({ name: "Renamed host", lastKnownStatus: "offline" });
    const text = JSON.stringify(service.executionTargets(["alpha"]));
    for (const secret of ["SECRET_KEY_PATH", "SECRET_HOST_KEY", "foreign.example", "auth", "createdAt"]) expect(text).not.toContain(secret);
  } finally { service.dispose(); }
});

test("execution context keeps lastKnownStatus pinned when only transient server status changes, and updates on config change", () => {
  let before!: (event: { systemPromptOptions: { cwd: string; sections: Record<string, string> } }) => void;
  let current = [{ id: "alpha", name: "Build host", host: "alpha.example", port: 22, username: "root", system: "Debian", lastKnownStatus: "offline" as const }];
  const extension = executionContextExtension({ localTools: ["read"], serverTools: ["server_exec"], servers: () => current });
  extension({ on: (_name: string, callback: typeof before) => { before = callback; } } as unknown as Parameters<ExtensionFactory>[0]);
  const capture = () => {
    const options = { cwd: "ws", sections: {} as Record<string, string> };
    before({ systemPromptOptions: options });
    return options.sections.execution_environment!;
  };
  const first = capture();
  // 仅连接状态从 offline 变为 ready，静态信息未变时必须保持字节一致，避免击穿系统提示词缓存。
  current = [{ ...current[0]!, lastKnownStatus: "ready" as const }];
  expect(capture()).toBe(first);
  // 用户显式修改主机名称时应同步更新环境清单及最新状态。
  current = [{ ...current[0]!, name: "Renamed host", lastKnownStatus: "ready" as const }];
  const updated = capture();
  expect(updated).not.toBe(first);
  expect(updated).toContain('"name":"Renamed host"');
  expect(updated).toContain('"lastKnownStatus":"ready"');
});
