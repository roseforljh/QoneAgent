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
      const key = api === "anthropic-messages" ? "input_schema" : api === "google-generative-ai"
        ? (Object.hasOwn(declaration, "parametersJsonSchema") ? "parametersJsonSchema" : "parameters") : "parameters";
      const schema = record(declaration[key]);
      if (typeof declaration.name === "string" && schema) {
        found.push({ name: `${scope}${declaration.name}`, declaration, key, schema, path: `${at}${fn ? ".function" : ""}.${key}` });
      }
    });
  }
  visit(api === "google-generative-ai" ? record(body.config)?.tools : body.tools, "tools");
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

export function repairRejectedSchema(error: string, tools: WireTool[], status?: number): { tool: WireTool; schema: RecordValue } | undefined {
  const rejection = schemaError(error, status);
  if (!rejection) return;
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
  if (!matches.length || (!named && !/\b(?:schema|keyword|pattern|regex|not supported|not permitted|unknown field)\b/i.test(message))) return;
  const tool = matches[0]!;
  if (matches.some((other) => other.name !== tool.name || JSON.stringify(other.schema) !== JSON.stringify(tool.schema))) return;
  const detail = named ? message.slice(named[0].length) : message;
  const keyword = /["'`]([\w$]+)["'`]\s+is (?:not (?:supported|permitted|allowed)|unsupported)/i.exec(detail)?.[1]
    ?? (/\b(?:pattern|regex)\b/i.test(detail) ? "pattern" : undefined);
  const exact = keyword && (project(tool.schema, (key, value) => {
    if (key !== keyword || typeof value !== "string") return false;
    const quoted = JSON.stringify(value);
    return detail.includes(quoted) || detail.includes(JSON.stringify(quoted).slice(1, -1)) || detail.includes(`'${value}'`);
  }) as RecordValue);
  const original = JSON.stringify(tool.schema);
  if (exact && JSON.stringify(exact) !== original) return { tool, schema: exact };
  const schema = project(tool.schema, keyword && !core.has(keyword) ? (key) => key === keyword : (key) => !core.has(key)) as RecordValue;
  if (JSON.stringify(schema) !== original) return { tool, schema };
  if (keyword) {
    const reduced = project(tool.schema, (key) => !core.has(key)) as RecordValue;
    if (JSON.stringify(reduced) !== original) return { tool, schema: reduced };
  }
}
