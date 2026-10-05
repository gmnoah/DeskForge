import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { CapabilityId } from "./capabilities.js";
import { coordinateToolCall } from "./coordinate.js";

test("capability load then an approved write reaches the executor", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deskforge-coord-"));
  const loaded: CapabilityId[] = [];
  const audit: string[] = [];
  const executed: Array<string> = [];
  try {
    const loadedResult = await coordinateToolCall({
      call: { name: "capability_load", args: { capability: "files" } },
      workspaceRoot: root,
      loaded,
      approve: async () => {
        throw new Error("load should not ask");
      },
      execute: async () => {
        throw new Error("load should not execute");
      },
      recordAudit: (event) => audit.push(event.decision),
    });
    assert.equal(loadedResult.ok, true);
    assert.equal(loadedResult.loadedCapability, "files");
    loaded.push("files");

    let asked = false;
    const denied = await coordinateToolCall({
      call: { name: "write_file", args: { path: "a.txt", content: "secret-token" } },
      workspaceRoot: root,
      loaded,
      approve: async () => {
        asked = true;
        return false;
      },
      execute: async () => {
        executed.push("write");
        return { ok: true, text: "nope" };
      },
      recordAudit: (event) => audit.push(event.decision),
    });
    assert.equal(asked, true);
    assert.equal(denied.ok, false);
    assert.equal(executed.length, 0);

    const approved = await coordinateToolCall({
      call: { name: "write_file", args: { path: "a.txt", content: "hello" } },
      workspaceRoot: root,
      loaded,
      approve: async (request) => {
        assert.equal(request.tier, "medium");
        const args = request.args as { content?: string };
        assert.equal(args.content, "hello");
        return true;
      },
      execute: async (call: { name: string; args: unknown }) => {
        executed.push(call.name);
        return { ok: true, text: "已写入" };
      },
      recordAudit: (event) => {
        audit.push(event.decision);
        const payload = event.payload as { args?: { content?: unknown } };
        if (payload.args && "content" in payload.args) {
          assert.deepEqual(payload.args.content, { bytes: Buffer.byteLength("hello") });
        }
      },
    });
    assert.equal(approved.text, "已写入");
    assert.deepEqual(executed, ["write_file"]);
    assert.equal(audit.includes("reject"), true);
    assert.equal(audit.includes("approve"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
