import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PathGuardError, assertSafeWorkspaceRoot, resolveWorkspaceCwd, resolveWorkspaceFile } from "./path-guard.js";

test("filesystem root is never a workspace", () => {
  assert.throws(() => assertSafeWorkspaceRoot("/"), PathGuardError);
  assert.throws(() => assertSafeWorkspaceRoot(""), PathGuardError);
});

test("relative escape and symlink escape are rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deskforge-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "deskforge-out-"));
  try {
    await mkdir(path.join(root, "notes"));
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await symlink(outside, path.join(root, "link"));
    const file = resolveWorkspaceFile(root, "notes/a.txt");
    assert.equal(file.startsWith(root), true);
    assert.throws(() => resolveWorkspaceFile(root, "../secret.txt"), PathGuardError);
    assert.throws(() => resolveWorkspaceFile(root, "link/secret.txt"), PathGuardError);
    assert.equal(resolveWorkspaceCwd(root), path.resolve(root));
    assert.throws(() => resolveWorkspaceCwd("/"), PathGuardError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
