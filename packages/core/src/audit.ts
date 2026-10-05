import { createHash } from "node:crypto";

export const AUDIT_GENESIS = "0".repeat(64);

export type AuditDecision = "allow" | "deny" | "approve" | "reject";

export interface AuditRecord {
  seq: number;
  ts: string;
  sessionId: string | null;
  action: string;
  decision: AuditDecision;
  payload: unknown;
  prevHash: string;
  hash: string;
}

export type AuditDraft = Omit<AuditRecord, "seq" | "prevHash" | "hash">;

/** Deterministic JSON so the hash does not depend on key insertion order. */
export function stableStringify(value: unknown): string {
  if (value === null) return "null";
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return JSON.stringify(value);
  }
  if (kind === "undefined") return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (kind === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return "null";
}

export function canonicalAudit(input: Omit<AuditRecord, "hash">): string {
  return stableStringify({
    action: input.action,
    decision: input.decision,
    payload: input.payload,
    prevHash: input.prevHash,
    seq: input.seq,
    sessionId: input.sessionId,
    ts: input.ts,
  });
}

export function sealAudit(input: Omit<AuditRecord, "hash">): AuditRecord {
  const hash = createHash("sha256").update(canonicalAudit(input)).digest("hex");
  return { ...input, hash };
}

export function verifyAuditChain(records: readonly AuditRecord[]): { ok: true } | { ok: false; seq: number } {
  let prev = AUDIT_GENESIS;
  for (const record of records) {
    if (record.prevHash !== prev) return { ok: false, seq: record.seq };
    const expected = sealAudit({
      seq: record.seq,
      ts: record.ts,
      sessionId: record.sessionId,
      action: record.action,
      decision: record.decision,
      payload: record.payload,
      prevHash: record.prevHash,
    });
    if (expected.hash !== record.hash) return { ok: false, seq: record.seq };
    prev = record.hash;
  }
  return { ok: true };
}
