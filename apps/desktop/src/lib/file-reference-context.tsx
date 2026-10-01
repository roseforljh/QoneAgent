import { createContext } from "react";

/** Relative references in a document resolve from that document's directory. */
export const FileReferenceContext = createContext<{ directory: string; root?: string; sessionId?: string; workspaceId?: string } | undefined>(undefined);
