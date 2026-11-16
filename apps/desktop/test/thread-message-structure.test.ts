import { expect, test } from "bun:test";
import { createMessageStructureSelector } from "../src/lib/thread-message-structure";
import { pairMessageIds } from "../src/components/assistant-ui/message-pairing";

type Message = Parameters<ReturnType<typeof createMessageStructureSelector>>[0][number];

function message(id: string, role: "user" | "assistant", custom: Record<string, unknown> = {}): Message {
  return {
    id, role, createdAt: new Date(1), metadata: { custom },
    content: [{ type: "text", text: id }],
    ...(role === "assistant" ? { status: { type: "complete", reason: "stop" } } : {}),
  } as unknown as Message;
}

test("a metadata-only communication marker produces a new structure", () => {
  const select = createMessageStructureSelector();
  const plain = [message("u1", "user"), message("a1", "assistant")];
  const first = select(plain);
  expect(select(plain)).toBe(first);

  // Same ids, parent, status and date: only the marker changed.
  const marked = [message("u1", "user", { qoneAgentCommunication: { fromId: "main" } }), message("a1", "assistant")];
  const next = select(marked);
  expect(next).not.toBe(first);
  expect(next).toBe(marked);
});

test("a marked row stops pairing, so its bubble stays visible", () => {
  const pair = (custom: Record<string, unknown>) => pairMessageIds([
    { id: "u1", role: "user", parentId: null, metadata: { custom } },
    { id: "a1", role: "assistant", parentId: "u1", status: { type: "complete" } },
  ]);
  expect(pair({}).get("a1")).toBe("u1");
  expect(pair({ qoneAgentCommunication: { fromId: "main" } }).get("a1")).toBeUndefined();
});
