import catalog from "./ecc-subagents.json";

export interface BuiltinSubagentCatalogEntry {
  id: string;
  name: string;
  description: string;
  instructions: string;
  sourceTools?: string[];
  recommendedModel?: string;
  references?: string[];
  tools?: string[];
}

export const ECC_BUILTIN_SUBAGENT_SOURCE = catalog.source;
export const ECC_BUILTIN_SUBAGENT_SOURCE_URL = catalog.sourceUrl;
export const ECC_BUILTIN_SUBAGENT_REVISION = catalog.revision;
const toolMap: Record<string, string> = {
  Read: "read",
  Grep: "grep",
  Glob: "find",
  Bash: "powershell",
  Write: "write",
  Edit: "edit",
};

export const ECC_BUILTIN_SUBAGENTS = (catalog.agents as BuiltinSubagentCatalogEntry[]).map((agent) => ({
  ...agent,
  tools: agent.sourceTools?.map((tool) => toolMap[tool]).filter((tool, index, all): tool is string => Boolean(tool) && all.indexOf(tool) === index),
}));
export const ECC_BUILTIN_SUBAGENT_IDS = ECC_BUILTIN_SUBAGENTS.map((agent) => agent.id);

export function eccBuiltinSubagentId(name: string): string {
  return `builtin:ecc:${name}`;
}

export function isEccBuiltinSubagentId(id: string): boolean {
  return id.startsWith("builtin:ecc:") && ECC_BUILTIN_SUBAGENT_IDS.includes(id);
}
