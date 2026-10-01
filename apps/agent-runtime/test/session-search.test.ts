import { expect, test } from "bun:test";
import { MessageRepo, SessionRepo, WorkspaceRepo, openDb } from "@qone/database";

test("session search avoids per-session message loading and preserves title/content semantics", () => {
  const db = openDb(":memory:");
  try {
    const workspaces = new WorkspaceRepo(db);
    const workspace = workspaces.upsert("project", "C:/project");
    const other = workspaces.upsert("other", "C:/other");
    const sessions = new SessionRepo(db);
    const title = sessions.create("needle in title", workspace.id);
    const content = sessions.create("ordinary chat", workspace.id);
    const orphan = sessions.create("orphan", "deleted-workspace");
    sessions.create("other workspace", other.id);
    new MessageRepo(db).add(content.id, "user", "A needle appears in the message body.");
    new MessageRepo(db).add(orphan.id, "user", "needle must not surface without a workspace.");
    expect(sessions.search("NEEDLE").map((item) => [item.session.id, item.match])).toEqual([
      [content.id, "content"], [title.id, "title"],
    ]);
    const unicode = sessions.create("École", workspace.id);
    new MessageRepo(db).add(unicode.id, "user", "Unicode content");
    expect(sessions.search("éCOLE").map((item) => [item.session.id, item.match])).toEqual([[unicode.id, "title"]]);
    expect(sessions.search("*")).toEqual([]);
  } finally { db.$client.close(); }
});

test("session search preserves Chinese and Unicode folding for ASCII queries", () => {
  const db = openDb(":memory:");
  try {
    const workspace = new WorkspaceRepo(db).upsert("project", "C:/project");
    const sessions = new SessionRepo(db);
    const messages = new MessageRepo(db);
    const chinese = sessions.create("中文会话", workspace.id);
    messages.add(chinese.id, "user", "查找性能问题");
    const kelvin = sessions.create("Kelvin", workspace.id);
    const dotted = sessions.create("chat", workspace.id);
    messages.add(dotted.id, "user", "İstanbul");
    expect(sessions.search(" 性能 ").map((item) => item.session.id)).toEqual([chinese.id]);
    expect(sessions.search("kELVIN").map((item) => item.session.id)).toEqual([kelvin.id]);
    expect(sessions.search("i").some((item) => item.session.id === dotted.id && item.content === "İstanbul")).toBe(true);
    messages.add(chinese.id, "assistant", "ÉCOLE");
    expect(sessions.search("école").map((item) => item.content)).toEqual(["ÉCOLE"]);
  } finally { db.$client.close(); }
});

test("session search picks the first inserted match on equal timestamps and titles take precedence", () => {
  const db = openDb(":memory:");
  try {
    const workspace = new WorkspaceRepo(db).upsert("project", "C:/project");
    const sessions = new SessionRepo(db);
    const messages = new MessageRepo(db);
    const content = sessions.create("ordinary", workspace.id);
    messages.add(content.id, "user", "first needle");
    messages.add(content.id, "assistant", "second needle");
    db.$client.query("UPDATE messages SET created_at = 1 WHERE session_id = ?").run(content.id);
    const title = sessions.create("needle title", workspace.id);
    messages.add(title.id, "user", "needle body");
    const matches = sessions.search("needle");
    expect(matches.find((item) => item.session.id === content.id)?.content).toBe("first needle");
    expect(matches.find((item) => item.session.id === title.id)?.match).toBe("title");
    expect(sessions.search(" ")).toEqual([]);
    expect(sessions.search("needle", 0)).toEqual([]);
  } finally { db.$client.close(); }
});

test("session search merges recent title and content hits before applying the result limit", () => {
  const db = openDb(":memory:");
  try {
    const workspace = new WorkspaceRepo(db).upsert("project", "C:/project");
    const sessions = new SessionRepo(db);
    const messages = new MessageRepo(db);
    const expected: string[] = [];
    db.$client.transaction(() => {
      for (let index = 0; index < 60; index++) {
        const session = sessions.create(index % 2 ? "needle title" : "ordinary", workspace.id);
        if (!(index % 2)) messages.add(session.id, "user", "needle content");
        db.$client.query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(index, session.id);
        expected.unshift(session.id);
      }
    })();
    expect(sessions.search("needle").map((item) => item.session.id)).toEqual(expected.slice(0, 50));
    expect(sessions.search("needle", 3).map((item) => item.session.id)).toEqual(expected.slice(0, 3));
    sessions.create("needle without workspace");
    expect(sessions.search("needle").map((item) => item.session.id)).toEqual(expected.slice(0, 50));
  } finally { db.$client.close(); }
});
