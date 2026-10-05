import assert from "node:assert/strict";
import test from "node:test";
import { AUDIT_GENESIS, sealAudit, stableStringify, verifyAuditChain } from "./audit.js";

test("stable stringify ignores key order", () => {
  assert.equal(stableStringify({ b: 1, a: "x" }), stableStringify({ a: "x", b: 1 }));
});

test("audit hash chain detects a rewritten payload", () => {
  const first = sealAudit({
    seq: 1,
    ts: "2026-10-05T00:00:00.000Z",
    sessionId: null,
    action: "read_file",
    decision: "allow",
    payload: { path: "a.txt" },
    prevHash: AUDIT_GENESIS,
  });
  const second = sealAudit({
    seq: 2,
    ts: "2026-10-05T00:00:01.000Z",
    sessionId: "s",
    action: "write_file",
    decision: "approve",
    payload: { path: "b.txt" },
    prevHash: first.hash,
  });
  assert.deepEqual(verifyAuditChain([first, second]), { ok: true });
  const tampered = { ...second, payload: { path: "secret.txt" } };
  assert.equal(verifyAuditChain([first, tampered]).ok, false);
});
