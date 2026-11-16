import { create } from "zustand";

/** Official MCP service icons keyed by server id, resolved and cached by the runtime. */
export const useMcpIcons = create<Record<string, string>>(() => ({}));
