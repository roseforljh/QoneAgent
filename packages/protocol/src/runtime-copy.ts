import { runtimeCopyCore } from "./runtime-copy-core";
import { subagentCopy } from "./subagent-copy";
export const runtimeCopy = { ...runtimeCopyCore, ...subagentCopy } as const;
