import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveModelProfile } from "./models.js";
import { SessionStore } from "./session-store.js";

test("sessions, messages, and the audit chain survive a reopen", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deskforge-db-"));
  const file = path.join(dir, "desk.sqlite");
  try {
    const profile = resolveModelProfile({ preset: "tongyi" });
    const store = new SessionStore(file);
    store.setSetting("workspaceRoot", path.join(dir, "work"));
    const session = store.createSession({ workspaceRoot: path.join(dir, "work"), profile, title: "笔记" });
    store.addMessage({ sessionId: session.id, role: "user", content: "你好" });
    store.appendAudit({ sessionId: session.id, action: "read_file", decision: "allow", payload: { path: "a.txt" } });
    store.appendAudit({ sessionId: session.id, action: "write_file", decision: "approve", payload: { path: "b.txt" } });
    assert.equal(store.verifyAudit().ok, true);
    store.close();

    const reopened = new SessionStore(file);
    assert.equal(reopened.getSetting("workspaceRoot"), path.join(dir, "work"));
    assert.equal(reopened.listMessages(session.id)[0]?.content, "你好");
    assert.equal(reopened.listAudit().length, 2);
    assert.equal(reopened.verifyAudit().ok, true);
    reopened.close();

    const raw = new DatabaseSync(file);
    raw.prepare("UPDATE audit_log SET payload_json = ? WHERE seq = 1").run(JSON.stringify({ path: "tampered" }));
    raw.close();
    const broken = new SessionStore(file);
    assert.equal(broken.verifyAudit().ok, false);
    broken.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
