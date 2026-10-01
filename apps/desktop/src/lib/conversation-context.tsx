import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useStore as useZustandStore, type StoreApi } from "zustand";
import { useStore, type AgentState } from "../store";
import { createConversationStore } from "./conversation-store";

const ConversationContext = createContext<StoreApi<AgentState> | undefined>(undefined);

export function ConversationProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const store = useMemo(() => createConversationStore(useStore, sessionId), [sessionId]);
  return <ConversationContext.Provider value={store}>{children}</ConversationContext.Provider>;
}

export function useConversationStoreApi() {
  return useContext(ConversationContext) ?? useStore;
}

export function useConversationStore<T>(selector: (state: AgentState) => T): T {
  return useZustandStore(useConversationStoreApi(), selector);
}
