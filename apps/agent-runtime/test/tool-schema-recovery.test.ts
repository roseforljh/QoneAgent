import { expect, test } from "bun:test";
import { repairRejectedSchema, wireTools } from "../src/tool-schema-recovery.js";

const schema = { type: "object", properties: { field: { type: "string", minLength: 3 } }, required: ["field"] };
const tools = wireTools("openai-responses", { input: [{ type: "tool_search_output", tools: [{ name: "first", parameters: schema }] }] });

test("an otherwise unspecified schema rejection uses the structural subset of only the named tool", () => {
  const repaired = repairRejectedSchema("merchant API error (400): Invalid schema for function 'first': not accepted", tools);
  expect(repaired?.schema).toEqual({ ...schema, properties: { field: { type: "string" } } });
  expect(schema.properties.field.minLength).toBe(3);
});

test("ordinary errors, wrong status, and unknown or ambiguous targets do not trigger schema retries", () => {
  const body = "Invalid schema for function 'first': 'minLength' is not permitted";
  for (const error of [
    body,
    `merchant API error (401): ${body}`,
    "400 Invalid arguments for tool 'first': not accepted",
    "400 Invalid schema for function 'other': 'minLength' is not permitted",
  ]) expect(repairRejectedSchema(error, tools)).toBeUndefined();
  expect(repairRejectedSchema(body, tools, 401)).toBeUndefined();
  expect(repairRejectedSchema(body, [...tools, { ...tools[0]!, schema: { type: "object" } }], 400)).toBeUndefined();
});
