import { writeFile } from 'node:fs/promises'
import type { RunDetail, SessionExportResult } from '@deskforge/contracts'
import { renderSessionMarkdown, sessionExportFileName } from '@deskforge/core'
import type { AppDatabase } from './database'

interface SecretDecoder { decrypt(value: Buffer): Promise<string> }

/** Collect every string leaf of a decrypted secret payload (JSON or plain). */
function secretLeaves(text: string): string[] {
  const values: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === 'string') { if (value.length >= 8) values.push(value) }
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  try { visit(JSON.parse(text)) } catch { visit(text) }
  if (!values.includes(text) && text.length >= 8 && !text.trim().startsWith('{')) values.push(text)
  return values
}

/**
 * Runtime-known secret values (model keys, MCP secrets/OAuth tokens,
 * embeddings key) so exports can redact exact matches, not just patterns.
 */
export async function collectKnownSecrets(database: AppDatabase, secrets: SecretDecoder): Promise<string[]> {
  const blobs: Buffer[] = []
  const sources = [
    'SELECT encrypted_key AS blob FROM model_profiles WHERE encrypted_key IS NOT NULL',
    'SELECT encrypted_secret AS blob FROM mcp_servers WHERE encrypted_secret IS NOT NULL',
    'SELECT encrypted AS blob FROM app_secrets',
  ]
  for (const sql of sources) {
    try { for (const row of database.db.prepare(sql).all() as Array<{ blob: Buffer }>) blobs.push(Buffer.from(row.blob)) } catch { /* table may not exist in old fixtures */ }
  }
  const values = new Set<string>()
  for (const blob of blobs) {
    try { for (const value of secretLeaves(await secrets.decrypt(blob))) values.add(value) } catch { /* undecryptable entries are skipped */ }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

export interface SessionExportDeps {
  database: AppDatabase
  secrets: SecretDecoder
  chooseTarget(defaultName: string): Promise<string | undefined>
  appVersion?: string
  timeZone?: string
}

export async function exportSessionMarkdown(detail: RunDetail, deps: SessionExportDeps): Promise<SessionExportResult | null> {
  const target = await deps.chooseTarget(sessionExportFileName(detail.run.title, detail.run.createdAt))
  if (!target) return null
  const workspace = detail.run.workspaceId ? deps.database.getWorkspace(detail.run.workspaceId) : undefined
  const markdown = renderSessionMarkdown(detail, {
    exportedAt: new Date(),
    knownSecrets: await collectKnownSecrets(deps.database, deps.secrets),
    ...(deps.timeZone ? { timeZone: deps.timeZone } : {}),
    ...(workspace?.name ? { workspaceName: String(workspace.name) } : {}),
    ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
  })
  await writeFile(target, markdown, { mode: 0o600 })
  const bytes = Buffer.byteLength(markdown)
  deps.database.audit('session', 'export_markdown', `导出会话「${detail.run.title.slice(0, 60)}」为 Markdown`, { actor: 'user', outcome: 'succeeded', target: detail.run.id, bytes }, detail.run.id)
  return { path: target, bytes, redacted: true }
}
