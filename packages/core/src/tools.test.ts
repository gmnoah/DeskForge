import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { executeApprovedTool } from "./tools.js";

test("file and shell tools stay inside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deskforge-tools-"));
  try {
    const write = await executeApprovedTool({
      name: "write_file",
      args: { path: "notes/hello.txt", content: "deskforge" },
      workspaceRoot: root,
      skillDirs: [],
    });
    assert.equal(write.ok, true);
    const read = await executeApprovedTool({
      name: "read_file",
      args: { path: "notes/hello.txt" },
      workspaceRoot: root,
      skillDirs: [],
    });
    assert.equal(read.text, "deskforge");
    const escaped = await executeApprovedTool({
      name: "read_file",
      args: { path: "../hello.txt" },
      workspaceRoot: root,
      skillDirs: [],
    });
    assert.equal(escaped.ok, false);
    const shell = await executeApprovedTool({
      name: "run_shell",
      args: { command: "pwd" },
      workspaceRoot: root,
      skillDirs: [],
    });
    assert.equal(shell.ok, true);
    assert.match(shell.text, /deskforge-tools-/);
    const rootWorkspace = await executeApprovedTool({
      name: "run_shell",
      args: { command: "pwd" },
      workspaceRoot: "/",
      skillDirs: [],
    });
    assert.equal(rootWorkspace.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
