import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { lstat, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import type { KnowledgeIndexSkipped, KnowledgeIndexStatus, KnowledgeSearchHit, KnowledgeSearchResult } from '@deskforge/contracts'
import { chunkText, cosineSimilarity, likePattern, planFtsQuery, reciprocalRankFusion, termHits, topK } from '@deskforge/core'
import { isWithinRoot, toPosix, walkWorkspace } from '../../workers/workspace-search'
import { extractDocxText } from './docx-text'
import { isSensitiveFile, knowledgeFileKind, type KnowledgeFileKind } from './file-policy'

/**
 * Per-workspace local knowledge index (M4).
 *
 * Each authorized workspace gets its own SQLite file under the app data
 * directory (never inside the workspace). Files are discovered with the same
 * walker as `file_search` (no symlinks, .gitignore honoured, bounded), split
 * into line-addressed chunks and indexed with FTS5 trigram for CJK + English
 * keyword search. Optional embeddings add a vector list fused with RRF.
 */

export const KNOWLEDGE_LIMITS = {
  maxFiles: 5_000,
  maxTextBytes: 1024 * 1024,
  maxDocxBytes: 20 * 1024 * 1024,
  maxEntriesScanned: 50_000,
  walkBudgetMs: 120_000,
  maxEmbedChunksPerBuild: 4_000,
  embedBatchSize: 10,
  embedInputChars: 2_000,
  defaultResults: 8,
  maxResults: 20,
  indexBatchSize: 200,
  /** Caps text held in memory per transaction; 200 large files would otherwise pin GBs. */
  indexBatchChars: 16 * 1024 * 1024,
} as const

export interface KnowledgeEmbedder {
  /** Identifies the vector space; changing it invalidates stored vectors. */
  readonly modelKey: string
  readonly host: string
  embed(texts: string[]): Promise<Float32Array[]>
}

export interface KnowledgeWorkspace { id: string; name: string; path: string }

export interface KnowledgeIndexProgressEvent {
  workspaceId: string
  phase: 'scan' | 'index' | 'embed'
  processed: number
  total: number
}

export interface KnowledgeIndexOptions {
  directory: string
  resolveWorkspace(id: string): KnowledgeWorkspace | undefined
  /** Returns an embedder only when the user enabled and configured embeddings. */
  embedder?: () => Promise<KnowledgeEmbedder | undefined>
  embeddingsEnabled?: () => boolean
  onEgress?: (event: { workspaceId: string; host: string; purpose: 'index' | 'query'; items: number }) => void
  onProgress?: (event: KnowledgeIndexProgressEvent) => void
  limits?: Partial<typeof KNOWLEDGE_LIMITS>
}

interface BuildMeta {
  indexedAt: string
  durationMs: number
  rootPath: string
  added: number
  updated: number
  unchanged: number
  removed: number
  skipped: KnowledgeIndexSkipped
  truncated: boolean
  limitReason?: string
  error?: string
  embeddingError?: string
}

const emptySkipped = (): KnowledgeIndexSkipped => ({ ignored: 0, symlinks: 0, unsupported: 0, sensitive: 0, tooLarge: 0, binary: 0, unreadable: 0 })

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    chunk_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chunks (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    content TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS chunks_path_idx ON chunks(path);
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(path, content, content='chunks', content_rowid='id', tokenize='trigram');
  CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, path, content) VALUES (new.id, new.path, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, path, content) VALUES ('delete', old.id, old.path, old.content);
    DELETE FROM embeddings WHERE chunk_id = old.id;
  END;
  CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL
  );
`

const toBlob = (vector: Float32Array): Buffer => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)
const fromBlob = (blob: Buffer): Float32Array => new Float32Array(new Uint8Array(blob).buffer)
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 500)

interface ChunkRow { id: number; path: string; start_line: number; end_line: number; content: string }

/** Snippet of up to `maxLines` lines around the first matching term, with exact line numbers. */
export function snippetForChunk(chunk: Pick<ChunkRow, 'content' | 'start_line'>, terms: string[], maxLines = 6): { startLine: number; endLine: number; text: string } {
  const lines = chunk.content.split('\n')
  const lowered = terms.map((term) => term.toLowerCase())
  let hit = lines.findIndex((line) => lowered.some((term) => line.toLowerCase().includes(term)))
  if (hit < 0) hit = 0
  const from = Math.max(0, hit - 1)
  const to = Math.min(lines.length - 1, from + maxLines - 1)
  const text = lines.slice(from, to + 1).map((line) => (line.length > 240 ? `${line.slice(0, 240)}…` : line)).join('\n')
  return { startLine: chunk.start_line + from, endLine: chunk.start_line + to, text }
}

export class KnowledgeIndexService {
  private connections = new Map<string, Database.Database>()
  private building = new Map<string, Promise<KnowledgeIndexStatus>>()
  private readonly limits: typeof KNOWLEDGE_LIMITS

  constructor(private options: KnowledgeIndexOptions) {
    this.limits = { ...KNOWLEDGE_LIMITS, ...options.limits }
    mkdirSync(options.directory, { recursive: true, mode: 0o700 })
  }

  databasePath(workspaceId: string): string {
    return join(this.options.directory, `${workspaceId.replace(/[^A-Za-z0-9_-]/g, '_')}.sqlite3`)
  }

  private open(workspaceId: string): Database.Database {
    const existing = this.connections.get(workspaceId)
    if (existing) return existing
    const db = new Database(this.databasePath(workspaceId))
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.exec(SCHEMA)
    this.connections.set(workspaceId, db)
    return db
  }

  private meta(db: Database.Database): BuildMeta | undefined {
    const row = db.prepare("SELECT value FROM meta WHERE key='last_build'").get() as { value?: string } | undefined
    if (!row?.value) return undefined
    try { return JSON.parse(row.value) as BuildMeta } catch { return undefined }
  }

  private writeMeta(db: Database.Database, meta: BuildMeta): void {
    db.prepare("INSERT INTO meta(key,value) VALUES('last_build',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(meta))
  }

  private requireWorkspace(workspaceId: string): KnowledgeWorkspace {
    const workspace = this.options.resolveWorkspace(workspaceId)
    if (!workspace) throw new Error('工作区不存在')
    return workspace
  }

  async status(workspaceId: string): Promise<KnowledgeIndexStatus> {
    const workspace = this.requireWorkspace(workspaceId)
    const db = this.open(workspaceId)
    const meta = this.meta(db)
    const counts = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM files').get() as { files: number; bytes: number }
    const chunks = (db.prepare('SELECT COUNT(*) AS count FROM chunks').get() as { count: number }).count
    const modelRow = db.prepare('SELECT model, COUNT(*) AS count FROM embeddings GROUP BY model ORDER BY count DESC LIMIT 1').get() as { model?: string; count?: number } | undefined
    let storageBytes = 0
    for (const suffix of ['', '-wal']) storageBytes += await stat(`${this.databasePath(workspaceId)}${suffix}`).then((info) => info.size, () => 0)
    const state = this.building.has(workspaceId) ? 'indexing' : meta?.error ? 'error' : counts.files > 0 || meta ? 'ready' : 'empty'
    return {
      workspaceId,
      workspaceName: workspace.name,
      rootPath: workspace.path,
      state: state === 'ready' && counts.files === 0 && !meta ? 'empty' : state,
      fileCount: counts.files,
      chunkCount: chunks,
      indexedBytes: counts.bytes,
      storageBytes,
      ...(meta?.indexedAt ? { indexedAt: meta.indexedAt } : {}),
      ...(meta ? { lastDurationMs: meta.durationMs, lastRun: { added: meta.added, updated: meta.updated, unchanged: meta.unchanged, removed: meta.removed } } : {}),
      skipped: meta?.skipped ?? emptySkipped(),
      truncated: meta?.truncated ?? false,
      ...(meta?.limitReason ? { limitReason: meta.limitReason } : {}),
      ...(meta?.error ? { error: meta.error } : {}),
      embeddings: {
        enabled: this.options.embeddingsEnabled?.() ?? false,
        ...(modelRow?.model ? { model: modelRow.model } : {}),
        embeddedChunks: modelRow?.count ?? 0,
        ...(meta?.embeddingError ? { error: meta.embeddingError } : {}),
      },
    }
  }

  build(workspaceId: string, mode: 'incremental' | 'full' = 'incremental'): Promise<KnowledgeIndexStatus> {
    const running = this.building.get(workspaceId)
    if (running) return running
    const task = this.runBuild(workspaceId, mode).finally(() => this.building.delete(workspaceId))
    this.building.set(workspaceId, task)
    return task
  }

  private async runBuild(workspaceId: string, mode: 'incremental' | 'full'): Promise<KnowledgeIndexStatus> {
    const workspace = this.requireWorkspace(workspaceId)
    const db = this.open(workspaceId)
    const started = Date.now()
    const skipped = emptySkipped()
    const counters = { added: 0, updated: 0, unchanged: 0, removed: 0 }
    let limitReason: string | undefined
    let root: string
    try {
      root = await realpath(workspace.path)
    } catch (error) {
      this.writeMeta(db, { ...(this.meta(db) ?? { added: 0, updated: 0, unchanged: 0, removed: 0, skipped, truncated: false, rootPath: workspace.path }), indexedAt: new Date().toISOString(), durationMs: Date.now() - started, error: `工作区目录不可访问：${errorMessage(error)}` })
      return this.status(workspaceId)
    }
    const previous = this.meta(db)
    if (mode === 'full' || (previous && previous.rootPath !== root)) {
      db.exec('DELETE FROM chunks; DELETE FROM files; DELETE FROM embeddings;')
    }

    // 1. Discover candidate files with the confined M2 walker.
    const candidates: Array<{ absolute: string; path: string; kind: KnowledgeFileKind }> = []
    const walkStats = await walkWorkspace({ root, base: root }, { maxEntries: this.limits.maxEntriesScanned, deadline: started + this.limits.walkBudgetMs }, (entry) => {
      if (entry.isDirectory) return true
      if (isSensitiveFile(entry.absolute)) { skipped.sensitive += 1; return true }
      const kind = knowledgeFileKind(entry.absolute)
      if (!kind) { skipped.unsupported += 1; return true }
      if (candidates.length >= this.limits.maxFiles) { limitReason = 'max_files'; return false }
      candidates.push({ absolute: entry.absolute, path: entry.display, kind })
      return true
    })
    skipped.ignored = walkStats.ignored
    skipped.symlinks = walkStats.symlinksSkipped
    const limitReasonFound = walkStats.limitReason && walkStats.limitReason !== 'max_results' ? walkStats.limitReason : limitReason
    const truncated = Boolean(limitReasonFound)
    limitReason = limitReasonFound

    // 2. Index new and changed files; unchanged size+mtime is skipped without reading.
    const existing = new Map((db.prepare('SELECT path,size,mtime_ms,sha256 FROM files').all() as Array<{ path: string; size: number; mtime_ms: number; sha256: string }>).map((row) => [row.path, row]))
    const seen = new Set<string>()
    const insertChunk = db.prepare('INSERT INTO chunks(path,ordinal,start_line,end_line,content) VALUES(?,?,?,?,?)')
    const upsertFile = db.prepare(`INSERT INTO files(path,kind,size,mtime_ms,sha256,chunk_count,indexed_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(path) DO UPDATE SET kind=excluded.kind,size=excluded.size,mtime_ms=excluded.mtime_ms,sha256=excluded.sha256,chunk_count=excluded.chunk_count,indexed_at=excluded.indexed_at`)
    const deleteChunks = db.prepare('DELETE FROM chunks WHERE path=?')

    interface PendingIndexItem {
      path: string
      kind: KnowledgeFileKind
      size: number
      mtimeMs: number
      sha: string
      text: string
      prior: boolean
    }

    const batchCommit = db.transaction((items: PendingIndexItem[]) => {
      for (const item of items) {
        deleteChunks.run(item.path)
        const chunks = chunkText(item.text)
        for (const chunk of chunks) insertChunk.run(item.path, chunk.ordinal, chunk.startLine, chunk.endLine, chunk.text)
        upsertFile.run(item.path, item.kind, item.size, item.mtimeMs, item.sha, chunks.length, new Date().toISOString())
      }
    })

    const indexBatchSize = this.limits.indexBatchSize
    const indexBatchChars = this.limits.indexBatchChars
    let pendingBatch: PendingIndexItem[] = []
    let pendingChars = 0
    let processedFiles = 0

    const flushIndexBatch = async () => {
      if (pendingBatch.length === 0) return
      batchCommit(pendingBatch)
      for (const item of pendingBatch) {
        seen.add(item.path)
        if (item.prior) counters.updated += 1
        else counters.added += 1
      }
      processedFiles += pendingBatch.length
      this.options.onProgress?.({
        workspaceId,
        phase: 'index',
        processed: processedFiles,
        total: candidates.length,
      })
      pendingBatch = []
      pendingChars = 0
      await new Promise((resolve) => setImmediate(resolve))
    }

    for (const candidate of candidates) {
      let info
      try {
        info = await lstat(candidate.absolute)
        // Re-check after discovery: no symlinks, and the canonical path must stay inside the root.
        if (!info.isFile()) { skipped.symlinks += 1; continue }
        if (!isWithinRoot(root, await realpath(candidate.absolute))) { skipped.symlinks += 1; continue }
      } catch { skipped.unreadable += 1; continue }
      const sizeLimit = candidate.kind === 'docx' ? this.limits.maxDocxBytes : this.limits.maxTextBytes
      if (info.size > sizeLimit) { skipped.tooLarge += 1; continue }
      const mtimeMs = Math.floor(info.mtimeMs)
      const prior = existing.get(candidate.path)
      if (prior && prior.size === info.size && prior.mtime_ms === mtimeMs) {
        seen.add(candidate.path)
        counters.unchanged += 1
        processedFiles += 1
        continue
      }
      let raw: Buffer
      try { raw = await readFile(candidate.absolute) } catch { skipped.unreadable += 1; continue }
      const sha = createHash('sha256').update(raw).digest('hex')
      if (prior && prior.sha256 === sha) {
        db.prepare('UPDATE files SET size=?,mtime_ms=? WHERE path=?').run(info.size, mtimeMs, candidate.path)
        seen.add(candidate.path)
        counters.unchanged += 1
        processedFiles += 1
        continue
      }
      let text: string
      try {
        if (candidate.kind === 'docx') text = extractDocxText(raw)
        else {
          if (raw.subarray(0, 8192).includes(0)) { skipped.binary += 1; continue }
          text = raw.toString('utf8').replace(/^\uFEFF/, '')
        }
      } catch { skipped.unreadable += 1; continue }

      pendingBatch.push({
        path: candidate.path,
        kind: candidate.kind,
        size: info.size,
        mtimeMs,
        sha,
        text,
        prior: Boolean(prior),
      })

      pendingChars += text.length
      if (pendingBatch.length >= indexBatchSize || pendingChars >= indexBatchChars) {
        await flushIndexBatch()
      }
    }

    await flushIndexBatch()

    // 3. Drop files that disappeared (or became ignored). On a truncated walk only drop files that no longer exist.
    const toDrop: string[] = []
    for (const path of existing.keys()) {
      if (seen.has(path)) continue
      if (truncated) {
        const stillThere = await lstat(join(root, path)).then(() => true, () => false)
        if (stillThere) continue
      }
      toDrop.push(path)
    }

    if (toDrop.length > 0) {
      db.transaction((paths: string[]) => {
        const delChunks = db.prepare('DELETE FROM chunks WHERE path=?')
        const delFiles = db.prepare('DELETE FROM files WHERE path=?')
        for (const path of paths) {
          delChunks.run(path)
          delFiles.run(path)
        }
      })(toDrop)
      counters.removed += toDrop.length
    }

    // 4. Optional embeddings for chunks that do not have a vector in the current space.
    let embeddingError: string | undefined
    try {
      const embedder = await this.options.embedder?.()
      if (embedder) await this.embedPending(workspaceId, db, embedder)
    } catch (error) {
      embeddingError = `向量生成失败（关键词索引仍可用）：${errorMessage(error)}`
    }

    this.writeMeta(db, {
      indexedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      rootPath: root,
      ...counters,
      skipped,
      truncated,
      ...(limitReason ? { limitReason } : {}),
      ...(embeddingError ? { embeddingError } : {}),
    })
    this.building.delete(workspaceId)
    return this.status(workspaceId)
  }

  private async embedPending(workspaceId: string, db: Database.Database, embedder: KnowledgeEmbedder): Promise<void> {
    db.prepare('DELETE FROM embeddings WHERE model <> ?').run(embedder.modelKey)
    const pending = db.prepare(`SELECT c.id, c.path, c.content FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
      WHERE e.chunk_id IS NULL ORDER BY c.id LIMIT ?`).all(this.limits.maxEmbedChunksPerBuild) as Array<{ id: number; path: string; content: string }>
    const insert = db.prepare('INSERT OR REPLACE INTO embeddings(chunk_id,model,dim,vector) VALUES(?,?,?,?)')
    if (pending.length) this.options.onEgress?.({ workspaceId, host: embedder.host, purpose: 'index', items: pending.length })
    for (let offset = 0; offset < pending.length; offset += this.limits.embedBatchSize) {
      const batch = pending.slice(offset, offset + this.limits.embedBatchSize)
      const vectors = await embedder.embed(batch.map((row) => `${row.path}\n${row.content}`.slice(0, this.limits.embedInputChars)))
      if (vectors.length !== batch.length) throw new Error('向量接口返回数量与请求不一致')
      db.transaction(() => {
        batch.forEach((row, index) => insert.run(row.id, embedder.modelKey, vectors[index]!.length, toBlob(vectors[index]!)))
      })()
    }
  }

  async clear(workspaceId: string): Promise<KnowledgeIndexStatus> {
    await this.drop(workspaceId)
    return this.status(workspaceId)
  }

  /** Close and delete the per-workspace index file (also used when a workspace is removed). */
  async drop(workspaceId: string): Promise<void> {
    await this.building.get(workspaceId)?.catch(() => undefined)
    this.connections.get(workspaceId)?.close()
    this.connections.delete(workspaceId)
    const path = this.databasePath(workspaceId)
    await Promise.all(['', '-wal', '-shm'].map((suffix) => rm(`${path}${suffix}`, { force: true })))
  }

  async search(workspaceId: string, query: string, options: { limit?: number; pathPrefix?: string } = {}): Promise<KnowledgeSearchResult> {
    this.requireWorkspace(workspaceId)
    const db = this.open(workspaceId)
    const meta = this.meta(db)
    const fileCount = (db.prepare('SELECT COUNT(*) AS count FROM files').get() as { count: number }).count
    const state = this.building.has(workspaceId) ? 'indexing' : fileCount > 0 ? 'ready' : meta?.error ? 'error' : 'empty'
    const limit = Math.min(Math.max(options.limit ?? this.limits.defaultResults, 1), this.limits.maxResults)
    const base = { query, state, fileCount, ...(meta?.indexedAt ? { indexedAt: meta.indexedAt } : {}) } as const
    if (!fileCount) {
      return { ...base, mode: 'keyword', results: [], note: '该工作区尚未建立本地知识索引。请在「设置 › 本地知识库」中建立索引，或改用 file_search。' }
    }
    const plan = planFtsQuery(query)
    const prefix = options.pathPrefix?.replace(/^\.?\/+/, '').replace(/\\/g, '/')
    const keyword = plan.terms.length ? this.keywordSearch(db, plan, prefix) : []

    let vectorIds: number[] = []
    let note: string | undefined
    let hybrid = false
    try {
      const embedder = await this.options.embedder?.()
      const hasVectors = embedder && db.prepare('SELECT 1 FROM embeddings WHERE model=? LIMIT 1').get(embedder.modelKey)
      if (embedder && hasVectors) {
        this.options.onEgress?.({ workspaceId, host: embedder.host, purpose: 'query', items: 1 })
        const [queryVector] = await embedder.embed([query.slice(0, this.limits.embedInputChars)])
        if (queryVector) {
          const rows = db.prepare(`SELECT e.chunk_id AS id, e.vector AS vector FROM embeddings e JOIN chunks c ON c.id = e.chunk_id
            WHERE e.model = ? ${prefix ? "AND c.path LIKE ? ESCAPE '\\'" : ''}`).iterate(...(prefix ? [embedder.modelKey, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : [embedder.modelKey])) as Iterable<{ id: number; vector: Buffer }>
          vectorIds = topK(rows, 30, (row) => cosineSimilarity(queryVector, fromBlob(row.vector)))
            .filter((entry) => entry.score >= 0.2)
            .map((entry) => entry.item.id)
          hybrid = true
        }
      }
    } catch (error) {
      note = `向量检索失败，已回退为关键词检索：${errorMessage(error)}`
    }

    const fused = reciprocalRankFusion<number>([{ ids: keyword }, ...(hybrid ? [{ ids: vectorIds }] : [])])
    const selected = fused.slice(0, limit)
    const rows = selected.length
      ? (db.prepare(`SELECT id,path,start_line,end_line,content FROM chunks WHERE id IN (${selected.map(() => '?').join(',')})`).all(...selected.map((item) => item.id)) as ChunkRow[])
      : []
    const byId = new Map(rows.map((row) => [row.id, row]))
    const keywordSet = new Set(keyword)
    const vectorSet = new Set(vectorIds)
    const results: KnowledgeSearchHit[] = []
    for (const item of selected) {
      const row = byId.get(item.id)
      if (!row) continue
      const snippet = snippetForChunk(row, plan.terms)
      results.push({
        path: row.path,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        chunkStartLine: row.start_line,
        chunkEndLine: row.end_line,
        snippet: snippet.text,
        score: Math.round(item.score * 10_000) / 10_000,
        matchedBy: keywordSet.has(item.id) && vectorSet.has(item.id) ? 'hybrid' : vectorSet.has(item.id) ? 'semantic' : 'keyword',
      })
    }
    if (!results.length && !note) note = '没有找到匹配的片段。可以换用更具体的关键词，或用 file_search 做精确搜索。'
    return { ...base, mode: hybrid ? 'hybrid' : 'keyword', results, ...(note ? { note } : {}) }
  }

  /** Ranked chunk ids: AND of all terms first, then an OR fallback for natural-language queries. */
  private keywordSearch(db: Database.Database, plan: ReturnType<typeof planFtsQuery>, prefix?: string): number[] {
    const prefixClause = prefix ? " AND c.path LIKE ? ESCAPE '\\'" : ''
    const prefixParams = prefix ? [`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`] : []
    const likeClause = plan.likeTerms.map(() => " AND (c.content LIKE ? ESCAPE '\\' OR c.path LIKE ? ESCAPE '\\')").join('')
    const likeParams = plan.likeTerms.flatMap((term) => [likePattern(term), likePattern(term)])
    let ids: number[]
    if (plan.match) {
      ids = (db.prepare(`SELECT c.id AS id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?${likeClause}${prefixClause} ORDER BY bm25(chunks_fts, 3.0, 1.0) LIMIT 50`).all(plan.match, ...likeParams, ...prefixParams) as Array<{ id: number }>).map((row) => row.id)
    } else {
      const rows = db.prepare(`SELECT c.id AS id, c.path AS path, c.content AS content FROM chunks c WHERE 1=1${likeClause}${prefixClause} LIMIT 5000`).all(...likeParams, ...prefixParams) as Array<{ id: number; path: string; content: string }>
      ids = rows.map((row) => ({ id: row.id, hits: termHits(row.content, plan.terms) + 3 * termHits(row.path, plan.terms) })).sort((a, b) => b.hits - a.hits).slice(0, 50).map((row) => row.id)
    }
    if (ids.length || plan.terms.length < 2) return ids
    const anyClause = plan.terms.map(() => "c.content LIKE ? ESCAPE '\\' OR c.path LIKE ? ESCAPE '\\'").join(' OR ')
    const rows = db.prepare(`SELECT c.id AS id, c.path AS path, c.content AS content FROM chunks c WHERE (${anyClause})${prefixClause} LIMIT 5000`)
      .all(...plan.terms.flatMap((term) => [likePattern(term), likePattern(term)]), ...prefixParams) as Array<{ id: number; path: string; content: string }>
    return rows
      .map((row) => {
        const text = `${row.path}\n${row.content}`
        const distinct = plan.terms.filter((term) => termHits(text, [term]) > 0).length
        return { id: row.id, rank: distinct * 100 + Math.min(termHits(text, plan.terms), 99) }
      })
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 50)
      .map((row) => row.id)
  }

  close(): void {
    for (const db of this.connections.values()) db.close()
    this.connections.clear()
  }
}

export const relativeDisplay = (root: string, absolute: string): string => toPosix(relative(root, absolute))
