import type { Api } from "@earendil-works/pi-ai";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export type WireTool = { name: string; declaration: RecordValue; key: string; path: string; schema: RecordValue };

/** Locate declarations after Pi has converted them to the target protocol, including mid-turn additions. */
export function wireTools(api: Api, payload: unknown): WireTool[] {
  const body = record(payload);
  if (!body) return [];
  const google = api === "google-generative-ai" || api === "google-vertex";
  const found: WireTool[] = [];
  function visit(tools: unknown, path: string, scope = "") {
    list(tools).forEach((entry, index) => {
      const item = record(entry);
      if (!item) return;
      const at = `${path}[${index}]`;
      if (item.type === "namespace" && typeof item.name === "string") visit(item.tools, `${at}.tools`, `${scope}${item.name}.`);
      visit(item.functionDeclarations, `${at}.functionDeclarations`, scope);
      const fn = record(item.function);
      const declaration = fn ?? item;
      const key = api === "anthropic-messages" ? "input_schema" : google
        ? (Object.hasOwn(declaration, "parametersJsonSchema") ? "parametersJsonSchema" : "parameters") : "parameters";
      const schema = record(declaration[key]);
      if (typeof declaration.name === "string" && schema) {
        found.push({ name: `${scope}${declaration.name}`, declaration, key, schema, path: `${at}${fn ? ".function" : ""}.${key}` });
      }
    });
  }
  visit(google ? record(body.config)?.tools : body.tools, "tools");
  for (const key of ["messages", "input"]) list(body[key]).forEach((item, index) => visit(record(item)?.tools, `${key}[${index}].tools`));
  return found;
}

const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
const schemaValues = new Set(["items", "prefixItems", "additionalItems", "additionalProperties", "unevaluatedItems", "unevaluatedProperties",
  "contains", "propertyNames", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "contentSchema"]);
const core = new Set(["type", "title", "description", "properties", "required", "items", "additionalProperties", "enum", "$ref", "$defs", "definitions"]);

function project(value: unknown, drop: (keyword: string, value: unknown) => boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => project(item, drop));
  const node = record(value);
  if (!node) return value;
  return Object.fromEntries(Object.entries(node).filter(([key, item]) => !drop(key, item)).map(([key, item]) => {
    if (schemaMaps.has(key) && record(item)) return [key, Object.fromEntries(Object.entries(item as RecordValue).map(([name, child]) => [name, project(child, drop)]))];
    return [key, schemaValues.has(key) ? project(item, drop) : item];
  }));
}

function schemaError(error: string, status?: number) {
  if (status !== undefined && status !== 400 && status !== 422) return;
  // Pi exposes an error string. SDKs may prefix the HTTP status, put it in JSON, or report it through onResponse.
  const body = /^(?:[^\r\n]*? API error \((?:400|422)\):\s*|(?:400|422)[\s:]+)([\s\S]+)$/i.exec(error)?.[1] ?? (status ? error : undefined);
  try {
    const parsed = record(JSON.parse(body ?? error));
    const detail = record(parsed?.error) ?? parsed;
    if (typeof detail?.message === "string" && (body || detail.code === 400 || detail.code === 422)) {
      return { message: detail.message, path: typeof detail.param === "string" ? detail.param : "" };
    }
  } catch { /* Some gateways return plain text. */ }
  if (body) return { message: body, path: "" };
}

export interface RejectedSchemaRepair {
  tool: WireTool;
  schema: RecordValue;
}

/** 识别被网关拒绝的 Schema 声明；若报错点名了具体非法字面量（如 surrogate 正则），同步精准清理同批次其他工具中完全相同的非法值。 */
export function repairRejectedSchemas(error: string, tools: WireTool[], status?: number): RejectedSchemaRepair[] {
  const rejection = schemaError(error, status);
  if (!rejection) return [];
  const { message, path } = rejection;
  const named = /^invalid (?:input )?schema for (?:function|tool) ["'`]([^"'`]+)["'`]\s*:?[ \t]*/i.exec(message);
  const canonical = (value: string) => value.replaceAll("_", "").toLowerCase();
  const atPath = (text: string, tool: WireTool) => {
    const value = canonical(text).replace(/^generatecontentrequest\./, "");
    const prefix = canonical(tool.path);
    return value === prefix || value.startsWith(`${prefix}.`) || value.startsWith(`${prefix}[`) || value.startsWith(`${prefix}:`);
  };
  const matches = tools.filter((tool) => atPath(path, tool) || atPath(message, tool) || tool.name === named?.[1]);
  // A path in a bad-request error is not enough by itself; it must describe a schema rejection, never tool arguments.
  if (!matches.length || (!named && !/\b(?:schema|keyword|pattern|regex|not supported|not permitted|unknown field)\b/i.test(message))) return [];
  const tool = matches[0]!;
  if (matches.some((other) => other.name !== tool.name || JSON.stringify(other.schema) !== JSON.stringify(tool.schema))) return [];
  const detail = named ? message.slice(named[0].length) : message;
  const keyword = /["'`]([\w$]+)["'`]\s+is (?:not (?:supported|permitted|allowed)|unsupported)/i.exec(detail)?.[1]
    ?? (/\b(?:pattern|regex)\b/i.test(detail) ? "pattern" : undefined);

  const exactValues = new Set<string>();
  const matchesExactValue = (key: string, value: unknown): boolean => {
    if (key !== keyword || typeof value !== "string") return false;
    const quoted = JSON.stringify(value);
    const hit = detail.includes(quoted) || detail.includes(JSON.stringify(quoted).slice(1, -1)) || detail.includes(`'${value}'`);
    if (hit) exactValues.add(value);
    return hit;
  };

  const exact = keyword ? (project(tool.schema, matchesExactValue) as RecordValue) : undefined;
  const original = JSON.stringify(tool.schema);
  if (exact && JSON.stringify(exact) !== original) {
    const repaired: RejectedSchemaRepair[] = [{ tool, schema: exact }];
    if (exactValues.size > 0) {
      // 同批次其他工具若带有完全一致的非法字面量（如多个 MCP 工具共享 ^[^\uD800-\uDFFF]*$），一次重试全部精准移除，不误伤其他约束。
      for (const candidate of tools) {
        if (candidate.name === tool.name) continue;
        const candidateOriginal = JSON.stringify(candidate.schema);
        const candidateFixed = project(candidate.schema, (key, value) => key === keyword && typeof value === "string" && exactValues.has(value)) as RecordValue;
        if (JSON.stringify(candidateFixed) !== candidateOriginal) {
          repaired.push({ tool: candidate, schema: candidateFixed });
        }
      }
    }
    return repaired;
  }

  const schema = project(tool.schema, keyword && !core.has(keyword) ? (key) => key === keyword : (key) => !core.has(key)) as RecordValue;
  if (JSON.stringify(schema) !== original) return [{ tool, schema }];
  if (keyword) {
    const reduced = project(tool.schema, (key) => !core.has(key)) as RecordValue;
    if (JSON.stringify(reduced) !== original) return [{ tool, schema: reduced }];
  }
  return [];
}

export function repairRejectedSchema(error: string, tools: WireTool[], status?: number): RejectedSchemaRepair | undefined {
  return repairRejectedSchemas(error, tools, status)[0];
}
