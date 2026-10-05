import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyAction } from "./policy.js";

test("reads are allowed inside the workspace; writes and shell wait for approval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deskforge-policy-"));
  try {
    assert.equal(
      classifyAction({ tool: "read_file", args: { path: "a.txt" }, workspaceRoot: root, loaded: ["files"] }).kind,
      "allow",
    );
    assert.equal(
      classifyAction({
        tool: "write_file",
        args: { path: "a.txt", content: "hi" },
        workspaceRoot: root,
        loaded: ["files"],
      }).kind,
      "require_approval",
    );
    const shell = classifyAction({
      tool: "run_shell",
      args: { command: "ls" },
      workspaceRoot: root,
      loaded: ["shell"],
    });
    assert.equal(shell.kind, "require_approval");
    assert.equal(
      classifyAction({ tool: "read_file", args: { path: "a.txt" }, workspaceRoot: root, loaded: [] }).kind,
      "deny",
    );
    assert.equal(
      classifyAction({ tool: "read_file", args: { path: "../a.txt" }, workspaceRoot: root, loaded: ["files"] }).kind,
      "deny",
    );
    assert.equal(
      classifyAction({ tool: "run_shell", args: { command: "rm -rf /" }, workspaceRoot: root, loaded: ["shell"] }).kind,
      "deny",
    );
    assert.equal(
      classifyAction({ tool: "read_file", args: { path: "a.txt" }, workspaceRoot: "/", loaded: ["files"] }).kind,
      "deny",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
