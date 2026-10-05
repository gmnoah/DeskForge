import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AUDIT_GENESIS, sealAudit, verifyAuditChain, type AuditDecision, type AuditRecord } from "./audit.js";
import { isCapabilityId, type CapabilityId } from "./capabilities.js";
import type { ModelProfile } from "./models.js";

export interface SessionRecord {
  id: string;
  title: string;
  workspaceRoot: string | null;
  profile: ModelProfile | null;
  capabilities: CapabilityId[];
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface SessionRow {
  id: string;
  title: string;
  workspace_root: string | null;
  model_json: string | null;
  capabilities_json: string;
  created_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

interface AuditRow {
  seq: number;
  ts: string;
  session_id: string | null;
  action: string;
  decision: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
}

function parseCapabilities(json: string): CapabilityId[] {
  try {
    const value = JSON.parse(json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(isCapabilityId);
  } catch {
    return [];
  }
}

function parseProfile(json: string | null): ModelProfile | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as ModelProfile;
    if (!value || typeof value.baseUrl !== "string" || typeof value.model !== "string") return null;
    return value;
  } catch {
    return null;
  }
}

function toSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    title: row.title,
    workspaceRoot: row.workspace_root,
    profile: parseProfile(row.model_json),
    capabilities: parseCapabilities(row.capabilities_json),
    createdAt: row.created_at,
  };
}

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT,
        model_json TEXT,
        capabilities_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        seq INTEGER PRIMARY KEY,
        ts TEXT NOT NULL,
        session_id TEXT,
        action TEXT NOT NULL,
        decision TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  createSession(input: { title?: string; workspaceRoot: string | null; profile: ModelProfile | null }): SessionRecord {
    const session: SessionRecord = {
      id: randomUUID(),
      title: input.title?.trim() || "未命名工作",
      workspaceRoot: input.workspaceRoot,
      profile: input.profile,
      capabilities: [],
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO sessions (id, title, workspace_root, model_json, capabilities_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        session.id,
        session.title,
        session.workspaceRoot,
        session.profile ? JSON.stringify(session.profile) : null,
        "[]",
        session.createdAt,
      );
    return session;
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  getSession(id: string): SessionRecord | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? toSession(row) : null;
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "workspaceRoot" | "profile" | "capabilities">>,
  ): SessionRecord | null {
    const current = this.getSession(id);
    if (!current) return null;
    const next: SessionRecord = {
      ...current,
      title: patch.title ?? current.title,
      workspaceRoot: patch.workspaceRoot === undefined ? current.workspaceRoot : patch.workspaceRoot,
      profile: patch.profile === undefined ? current.profile : patch.profile,
      capabilities: patch.capabilities ?? current.capabilities,
    };
    this.db
      .prepare("UPDATE sessions SET title = ?, workspace_root = ?, model_json = ?, capabilities_json = ? WHERE id = ?")
      .run(
        next.title,
        next.workspaceRoot,
        next.profile ? JSON.stringify(next.profile) : null,
        JSON.stringify(next.capabilities),
        id,
      );
    return next;
  }

  addMessage(input: { sessionId: string; role: "user" | "assistant"; content: string }): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(message.id, message.sessionId, message.role, message.content, message.createdAt);
    return message;
  }

  listMessages(sessionId: string): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC")
      .all(sessionId) as unknown as MessageRow[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      role: row.role === "assistant" ? "assistant" : "user",
      content: row.content,
      createdAt: row.created_at,
    }));
  }

  appendAudit(input: {
    sessionId: string | null;
    action: string;
    decision: AuditDecision;
    payload: unknown;
    ts?: string;
  }): AuditRecord {
    const previous = this.db
      .prepare("SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1")
      .get() as { seq: number; hash: string } | undefined;
    const record = sealAudit({
      seq: (previous?.seq ?? 0) + 1,
      ts: input.ts ?? new Date().toISOString(),
      sessionId: input.sessionId,
      action: input.action,
      decision: input.decision,
      payload: input.payload,
      prevHash: previous?.hash ?? AUDIT_GENESIS,
    });
    this.db
      .prepare(
        "INSERT INTO audit_log (seq, ts, session_id, action, decision, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.seq,
        record.ts,
        record.sessionId,
        record.action,
        record.decision,
        JSON.stringify(record.payload),
        record.prevHash,
        record.hash,
      );
    return record;
  }

  listAudit(limit = 50): AuditRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?")
      .all(limit) as unknown as AuditRow[];
    return rows.map(rowToAudit).reverse();
  }

  listAuditAll(): AuditRecord[] {
    const rows = this.db.prepare("SELECT * FROM audit_log ORDER BY seq ASC").all() as unknown as AuditRow[];
    return rows.map(rowToAudit);
  }

  verifyAudit(): { ok: true } | { ok: false; seq: number } {
    return verifyAuditChain(this.listAuditAll());
  }
}

function rowToAudit(row: AuditRow): AuditRecord {
  return {
    seq: row.seq,
    ts: row.ts,
    sessionId: row.session_id,
    action: row.action,
    decision: row.decision as AuditDecision,
    payload: JSON.parse(row.payload_json) as unknown,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}
