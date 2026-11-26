import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpElicitations } from "./mcp-elicitation.js";
import type { ServerService } from "./servers/server-service.js";

export const SECRET_INPUT_TOOL = "qone_secret_input";
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const LOCAL = "";
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

type Remote = Pick<ServerService, "find" | "replaceText">;
type Input = { name: string; message: string; server?: string; env?: boolean; file?: string; placeholder?: string };

/**
 * Secrets the person types straight into Qone. The value goes from the prompt
 * to its destination (a file placeholder, or the shell environment of this
 * conversation's local or SSH commands) without entering the model context,
 * and any later tool output that contains it is masked before the model reads it.
 */
export class SecretInputs {
  /** Typed value -> masked label. */
  private readonly masks = new Map<string, string>();
  /** Conversation -> machine ("" for this computer, else server ID) -> variables. */
  private readonly envs = new Map<string, Map<string, Record<string, string>>>();

  constructor(private readonly elicitations: McpElicitations, private readonly remote?: Remote) {}

  /** Variables added to this conversation's commands on this computer, or on one server. */
  env(sessionId: string, serverId = LOCAL): Record<string, string> {
    return this.envs.get(sessionId)?.get(serverId) ?? {};
  }

  redact<T>(result: T): T {
    if (!this.masks.size) return result;
    // Tool text is often JSON inside JSON, so also match the JSON-escaped form of values with quotes or backslashes.
    const forms = [...this.masks].flatMap(([value, label]) => [[value, label], [JSON.stringify(value).slice(1, -1), label]]);
    const mask = (value: unknown): unknown => typeof value === "string"
      ? forms.reduce((text, [secret, label]) => text.split(secret!).join(label), value)
      : Array.isArray(value) ? value.map(mask)
      : value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mask(item)]))
      : value;
    return mask(result) as T;
  }

  /** Masks typed secrets in a tool's streamed and final output. */
  wrap(tool: ToolDefinition): ToolDefinition {
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate, ctx) => this.redact(await tool.execute(
        toolCallId, params, signal, onUpdate && ((partial) => onUpdate(this.redact(partial))), ctx,
      )),
    };
  }

  tool(sessionId: string, workspacePath: string, serverIds: readonly string[] = []): ToolDefinition {
    const remote = serverIds.length ? this.remote : undefined;
    return {
      name: SECRET_INPUT_TOOL,
      label: "Ask for a secret",
      description: "Ask the person to type a secret (API key, token, password, private environment value) directly into Qone. The value goes straight to its destination and never enters this conversation. Use this instead of asking the person to paste a secret into chat. Destinations: env=true makes it environment variable `name` for later commands in this conversation (local powershell: $env:NAME; with server: server_exec on that server: $NAME); never print it. file + placeholder replaces every occurrence of that exact placeholder text in a file, so write the placeholder there first. Any later tool output containing the value shows [secret:NAME].",
      parameters: Type.Object({
        name: Type.String({ pattern: NAME.source, description: "Identifier such as GITHUB_TOKEN; also the environment variable name when env is true." }),
        message: Type.String({ minLength: 1, maxLength: 1000, description: "In the person's language: what this secret is for and where to get it." }),
        ...(remote ? { server: Type.Optional(Type.String({ description: "SSH server ID or name. Set it when the destination is on that server: env applies to its server_exec commands, file is a remote path. Omit for this computer." })) } : {}),
        env: Type.Optional(Type.Boolean({ description: "Expose as environment variable NAME to later commands in this conversation, on this computer or on server." })),
        file: Type.Optional(Type.String({ minLength: 1, description: "File containing the placeholder. Local: absolute or relative to the workspace. Remote: absolute or relative to the SSH user's home." })),
        placeholder: Type.Optional(Type.String({ minLength: 4, description: "Exact text in file to replace with the secret." })),
      }),
      execute: async (_toolCallId, params, signal) => {
        const input = params as Input;
        if (!NAME.test(input.name)) throw new Error("name must be an identifier such as GITHUB_TOKEN.");
        if (!input.env && !input.file) throw new Error("Choose a destination: env=true, or file with placeholder.");
        if (input.file && !input.placeholder) throw new Error("file needs the placeholder text to replace.");
        const server = input.server ? (remote ?? this.unavailable()).find(serverIds, input.server) : undefined;
        const replace = async (value?: string) => {
          if (!input.file) return undefined;
          if (server) return remote!.replaceText(server, input.file, input.placeholder!, value, signal);
          const file = path.resolve(workspacePath, input.file);
          const parts = (await fs.readFile(file, "utf8")).split(input.placeholder!);
          if (value !== undefined && parts.length > 1) await fs.writeFile(file, parts.join(value), "utf8");
          return { path: file, replaced: parts.length - 1 };
        };
        // Check the destination first so the person never types a secret that cannot be stored.
        const found = await replace();
        if (found && !found.replaced) throw new Error(`Placeholder not found in ${found.path}. Write it into the file first.`);
        const answer = await this.elicitations.request({
          serverId: "qone", serverName: "Qone", sessionId, message: input.message, mode: "form",
          fields: { value: { type: "string", title: input.name, format: "password", minLength: 1 } }, required: ["value"],
          secretTarget: { ...(input.env ? { env: input.name } : {}), ...(found ? { file: found.path } : {}), ...(server ? { server: server.name } : {}) },
        }, signal ?? new AbortController().signal);
        const value = answer.action === "accept" ? String(answer.content?.value ?? "").trim() : "";
        if (!value) return text({ status: answer.action === "accept" ? "empty" : "declined", name: input.name });
        // Replaced again: the file may have changed while the person was typing.
        const written = await replace(value);
        if (written && !written.replaced) throw new Error(`Placeholder no longer found in ${written.path}; nothing was written.`);
        if (input.env) {
          const machines = this.envs.get(sessionId) ?? new Map<string, Record<string, string>>();
          const machine = server?.id ?? LOCAL;
          machines.set(machine, { ...machines.get(machine), [input.name]: value });
          this.envs.set(sessionId, machines);
        }
        // Values under 4 characters stay unmasked: masking them would mangle unrelated output.
        if (value.length >= 4) this.masks.set(value, `[secret:${input.name}]`);
        return text({ status: "saved", name: input.name, ...(server ? { server: server.name } : {}),
          ...(input.env ? { env: server ? `$${input.name}` : `$env:${input.name}` } : {}), ...(written ? { file: written.path, replaced: written.replaced } : {}) });
      },
    };
  }

  private unavailable(): never {
    throw new Error("No SSH server is enabled for this conversation.");
  }
}
