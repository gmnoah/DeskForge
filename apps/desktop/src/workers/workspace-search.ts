import { spawn, type ChildProcess } from 'node:child_process'
import { lstat, open, readFile, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import picomatch from 'picomatch'

/**
 * Read-only workspace search used by `file_find` / `file_search`.
 * Every returned path is confined to the authorized root: symlinks are never
 * followed, `.gitignore` is honoured, and all scans are bounded.
 */

export const SEARCH_ALWAYS_EXCLUDED = new Set(['.git', 'node_modules', '.deskforge-trash'])
export const SEARCH_LIMITS = {
  defaultResults: 200,
  maxResults: 1_000,
  defaultFileBytes: 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxEntriesScanned: 20_000,
  timeBudgetMs: 10_000,
  maxLineChars: 300,
  binarySniffBytes: 8 * 1024,
} as const

export type LimitReason = 'max_results' | 'max_entries' | 'time_budget'

export interface SearchScope {
  /** Real path of the authorized workspace root. */
  root: string
  /** Real path of the directory to search; must already be inside root. */
  base: string
  /** Paths are reported relative to this directory (the workspace) when possible. */
  displayRoot?: string
}

export function displayPath(scope: SearchScope, absolute: string): string {
  const anchor = scope.displayRoot && isWithinRoot(scope.displayRoot, absolute) ? scope.displayRoot : scope.root
  return toPosix(relative(anchor, absolute)) || '.'
}

export interface FindFilesOptions {
  pattern: string
  type?: 'file' | 'directory' | 'any'
  maxResults?: number
  timeBudgetMs?: number
  maxEntries?: number
}

export interface SearchContentOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  glob?: string
  maxResults?: number
  maxFileBytes?: number
  timeBudgetMs?: number
  maxEntries?: number
  engine?: 'auto' | 'builtin' | 'ripgrep'
  ripgrepPath?: string
  env?: NodeJS.ProcessEnv
  onChild?: (child: ChildProcess) => (() => void)
}

export interface SearchMatch { path: string; line: number; column: number; text: string }

const clamp = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(1, Math.min(max, parsed))
}

export const toPosix = (value: string): string => value.split(sep).join('/')

export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

export function assertScope(scope: SearchScope): void {
  if (!isWithinRoot(scope.root, scope.base)) throw Object.assign(new Error('搜索目录超出授权工作区'), { code: 'PATH_OUTSIDE_WORKSPACE' })
}

const hasGlobSyntax = (value: string): boolean => /[*?[\]{}!]/.test(value)

/** Plain text matches as a case-insensitive substring; globs match the basename unless they contain `/`. */
export function compileNameMatcher(pattern: string, caseSensitive = false): (relativePath: string) => boolean {
  const trimmed = pattern.trim()
  if (!trimmed) throw Object.assign(new Error('搜索模式不能为空'), { code: 'INVALID_PATTERN' })
  if (!hasGlobSyntax(trimmed)) {
    const needle = caseSensitive ? trimmed : trimmed.toLowerCase()
    const usePath = trimmed.includes('/')
    return (relativePath) => {
      const subject = usePath ? relativePath : relativePath.slice(relativePath.lastIndexOf('/') + 1)
      return (caseSensitive ? subject : subject.toLowerCase()).includes(needle)
    }
  }
  const matcher = picomatch(trimmed.replace(/^\.\//, ''), { dot: true, nocase: !caseSensitive, basename: !trimmed.includes('/') })
  return (relativePath) => matcher(relativePath)
}

interface IgnoreLayer { dir: string; matcher: Ignore }

async function readIgnoreFile(dir: string): Promise<Ignore | undefined> {
  const file = join(dir, '.gitignore')
  try {
    const info = await lstat(file)
    // A symlinked .gitignore could point outside the workspace; ignore it.
    if (!info.isFile() || info.size > 256 * 1024) return undefined
    return ignore({ allowRelativePaths: true }).add(await readFile(file, 'utf8'))
  } catch { return undefined }
}

function ignoredBy(layers: IgnoreLayer[], absolutePath: string, isDirectory: boolean): boolean {
  let ignored = false
  for (const layer of layers) {
    const rel = toPosix(relative(layer.dir, absolutePath))
    if (!rel || rel.startsWith('..')) continue
    const result = layer.matcher.test(isDirectory ? `${rel}/` : rel)
    if (result.ignored) ignored = true
    else if (result.unignored) ignored = false
  }
  return ignored
}

export interface WalkEntry { absolute: string; /** Relative to the search base, used for glob matching. */ relative: string; display: string; isDirectory: boolean }
export interface WalkStats { scanned: number; ignored: number; symlinksSkipped: number; limitReason?: LimitReason }

/** Breadth-first walk that never follows symlinks and stops at the configured caps. */
export async function walkWorkspace(scope: SearchScope, options: { maxEntries: number; deadline: number }, visit: (entry: WalkEntry) => boolean | Promise<boolean>): Promise<WalkStats> {
  assertScope(scope)
  const stats: WalkStats = { scanned: 0, ignored: 0, symlinksSkipped: 0 }
  // Parent .gitignore files between the root and the search base still apply.
  const initialLayers: IgnoreLayer[] = []
  const chain: string[] = []
  for (let current = scope.base; isWithinRoot(scope.root, current); current = join(current, '..')) {
    chain.unshift(current)
    if (current === scope.root) break
  }
  for (const dir of chain.slice(0, -1)) {
    const matcher = await readIgnoreFile(dir)
    if (matcher) initialLayers.push({ dir, matcher })
  }
  const queue: Array<{ dir: string; layers: IgnoreLayer[] }> = [{ dir: scope.base, layers: initialLayers }]
  while (queue.length) {
    const { dir, layers: parentLayers } = queue.shift()!
    const own = await readIgnoreFile(dir)
    const layers = own ? [...parentLayers, { dir, matcher: own }] : parentLayers
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (Date.now() > options.deadline) { stats.limitReason = 'time_budget'; return stats }
      if (stats.scanned >= options.maxEntries) { stats.limitReason = 'max_entries'; return stats }
      stats.scanned += 1
      const absolute = join(dir, entry.name)
      if (entry.isSymbolicLink()) { stats.symlinksSkipped += 1; continue }
      const isDirectory = entry.isDirectory()
      if (!isDirectory && !entry.isFile()) continue
      if (SEARCH_ALWAYS_EXCLUDED.has(entry.name) || /^\.deskforge-.*\.tmp$/.test(entry.name)) { stats.ignored += 1; continue }
      if (ignoredBy(layers, absolute, isDirectory)) { stats.ignored += 1; continue }
      const keepGoing = await visit({ absolute, relative: toPosix(relative(scope.base, absolute)), display: displayPath(scope, absolute), isDirectory })
      if (!keepGoing) { stats.limitReason = 'max_results'; return stats }
      if (isDirectory) queue.push({ dir: absolute, layers })
    }
  }
  return stats
}

export async function findFiles(scope: SearchScope, options: FindFilesOptions): Promise<Record<string, unknown>> {
  const maxResults = clamp(options.maxResults, SEARCH_LIMITS.defaultResults, SEARCH_LIMITS.maxResults)
  const type = options.type ?? 'file'
  const matches = compileNameMatcher(options.pattern)
  const results: Array<{ path: string; type: 'file' | 'directory' }> = []
  const stats = await walkWorkspace(scope, {
    maxEntries: clamp(options.maxEntries, SEARCH_LIMITS.maxEntriesScanned, SEARCH_LIMITS.maxEntriesScanned),
    deadline: Date.now() + clamp(options.timeBudgetMs, SEARCH_LIMITS.timeBudgetMs, SEARCH_LIMITS.timeBudgetMs),
  }, (entry) => {
    if ((type === 'file' && entry.isDirectory) || (type === 'directory' && !entry.isDirectory)) return true
    if (!matches(entry.relative)) return true
    if (results.length >= maxResults) return false
    results.push({ path: entry.display, type: entry.isDirectory ? 'directory' : 'file' })
    return true
  })
  return {
    engine: 'builtin',
    pattern: options.pattern,
    base: displayPath(scope, scope.base),
    matches: results,
    matchCount: results.length,
    truncated: Boolean(stats.limitReason),
    ...(stats.limitReason ? { limitReason: stats.limitReason } : {}),
    scannedEntries: stats.scanned,
    skipped: { ignored: stats.ignored, symlinks: stats.symlinksSkipped },
  }
}

export function compileContentMatcher(options: Pick<SearchContentOptions, 'query' | 'regex' | 'caseSensitive'>): RegExp {
  if (!options.query) throw Object.assign(new Error('搜索内容不能为空'), { code: 'INVALID_PATTERN' })
  const source = options.regex ? options.query : options.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return new RegExp(source, options.caseSensitive ? 'gu' : 'giu')
  } catch (error) {
    throw Object.assign(new Error(`正则表达式无效：${error instanceof Error ? error.message : String(error)}`), { code: 'INVALID_REGEX' })
  }
}

const clipLine = (line: string): string => line.length > SEARCH_LIMITS.maxLineChars ? `${line.slice(0, SEARCH_LIMITS.maxLineChars)}…` : line

export async function sniffBinary(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(SEARCH_LIMITS.binarySniffBytes)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally { await handle.close() }
}

async function searchBuiltin(scope: SearchScope, options: SearchContentOptions): Promise<Record<string, unknown>> {
  const maxResults = clamp(options.maxResults, SEARCH_LIMITS.defaultResults, SEARCH_LIMITS.maxResults)
  const maxFileBytes = clamp(options.maxFileBytes, SEARCH_LIMITS.defaultFileBytes, SEARCH_LIMITS.maxFileBytes)
  const matcher = compileContentMatcher(options)
  const globMatcher = options.glob ? compileNameMatcher(options.glob) : undefined
  const matches: SearchMatch[] = []
  const files = new Set<string>()
  let binary = 0
  let tooLarge = 0
  const stats = await walkWorkspace(scope, {
    maxEntries: clamp(options.maxEntries, SEARCH_LIMITS.maxEntriesScanned, SEARCH_LIMITS.maxEntriesScanned),
    deadline: Date.now() + clamp(options.timeBudgetMs, SEARCH_LIMITS.timeBudgetMs, SEARCH_LIMITS.timeBudgetMs),
  }, async (entry) => {
    if (entry.isDirectory) return true
    if (globMatcher && !globMatcher(entry.relative)) return true
    const info = await lstat(entry.absolute)
    if (!info.isFile()) return true
    if (info.size > maxFileBytes) { tooLarge += 1; return true }
    if (await sniffBinary(entry.absolute)) { binary += 1; return true }
    const lines = (await readFile(entry.absolute, 'utf8')).split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0
      const found = matcher.exec(lines[index]!)
      if (!found) continue
      if (matches.length >= maxResults) return false
      matches.push({ path: entry.display, line: index + 1, column: found.index + 1, text: clipLine(lines[index]!) })
      files.add(entry.display)
    }
    return true
  })
  return {
    engine: 'builtin',
    query: options.query,
    regex: Boolean(options.regex),
    caseSensitive: Boolean(options.caseSensitive),
    matches,
    matchCount: matches.length,
    filesWithMatches: files.size,
    truncated: Boolean(stats.limitReason),
    ...(stats.limitReason ? { limitReason: stats.limitReason } : {}),
    scannedEntries: stats.scanned,
    skipped: { ignored: stats.ignored, symlinks: stats.symlinksSkipped, binary, tooLarge },
  }
}

export function ripgrepArgs(scope: SearchScope, options: SearchContentOptions): string[] {
  const maxFileBytes = clamp(options.maxFileBytes, SEARCH_LIMITS.defaultFileBytes, SEARCH_LIMITS.maxFileBytes)
  return [
    '--json', '--hidden', '--no-follow', '--no-require-git', '--no-config',
    '--max-filesize', String(maxFileBytes),
    '--glob', '!.git', '--glob', '!node_modules', '--glob', '!.deskforge-trash', '--glob', '!.deskforge-*.tmp',
    options.caseSensitive ? '--case-sensitive' : '--ignore-case',
    ...(options.regex ? [] : ['--fixed-strings']),
    ...(options.glob ? ['--glob', options.glob] : []),
    '--regexp', options.query,
    '--', scope.base,
  ]
}

async function searchRipgrep(scope: SearchScope, options: SearchContentOptions): Promise<Record<string, unknown>> {
  const maxResults = clamp(options.maxResults, SEARCH_LIMITS.defaultResults, SEARCH_LIMITS.maxResults)
  if (options.regex) compileContentMatcher(options)
  const budget = clamp(options.timeBudgetMs, SEARCH_LIMITS.timeBudgetMs, SEARCH_LIMITS.timeBudgetMs)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(options.ripgrepPath ?? 'rg', ripgrepArgs(scope, options), { cwd: scope.base, env: options.env ?? process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const release = options.onChild?.(child)
    const matches: SearchMatch[] = []
    const files = new Set<string>()
    let outside = 0
    let limitReason: LimitReason | undefined
    let buffered = ''
    let stderr = ''
    let settled = false
    const stop = (): void => { try { process.kill(-child.pid!, 'SIGTERM') } catch { /* already exited */ } }
    const timer = setTimeout(() => { limitReason = 'time_budget'; stop() }, budget)
    const handleLine = (line: string): void => {
      if (!line || limitReason) return
      let message: any
      try { message = JSON.parse(line) } catch { return }
      if (message?.type !== 'match') return
      const absolute = message.data?.path?.text
      if (typeof absolute !== 'string') return
      // rg never follows symlinks here, but keep a lexical confinement check.
      if (!isWithinRoot(scope.root, absolute)) { outside += 1; return }
      const rel = displayPath(scope, absolute)
      const text = String(message.data?.lines?.text ?? '').replace(/\r?\n$/, '')
      const submatches = Array.isArray(message.data?.submatches) ? message.data.submatches : []
      const start = Number(submatches[0]?.start ?? 0)
      if (matches.length >= maxResults) { limitReason = 'max_results'; stop(); return }
      matches.push({ path: rel, line: Number(message.data?.line_number ?? 0), column: Buffer.from(text, 'utf8').subarray(0, start).toString('utf8').length + 1, text: clipLine(text) })
      files.add(rel)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      let index = buffered.indexOf('\n')
      while (index >= 0) { handleLine(buffered.slice(0, index)); buffered = buffered.slice(index + 1); index = buffered.indexOf('\n') }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => { if (stderr.length < 4_000) stderr += chunk })
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      release?.()
      if (error) { reject(error); return }
      resolvePromise({
        engine: 'ripgrep',
        query: options.query,
        regex: Boolean(options.regex),
        caseSensitive: Boolean(options.caseSensitive),
        matches,
        matchCount: matches.length,
        filesWithMatches: files.size,
        truncated: Boolean(limitReason),
        ...(limitReason ? { limitReason } : {}),
        ...(outside ? { droppedOutsideWorkspace: outside } : {}),
      })
    }
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      handleLine(buffered)
      // Exit code 1 means "no matches"; 2 can mean partial errors such as unreadable files.
      if (code === 0 || code === 1 || limitReason || (code === 2 && matches.length)) finish()
      else finish(Object.assign(new Error(`ripgrep 失败：${stderr.trim() || `退出码 ${String(code)}`}`), { code: 'SEARCH_FAILED' }))
    })
  })
}

export async function searchContents(scope: SearchScope, options: SearchContentOptions): Promise<Record<string, unknown>> {
  assertScope(scope)
  compileContentMatcher(options)
  const engine = options.engine ?? 'auto'
  if (engine === 'builtin') return searchBuiltin(scope, options)
  try {
    return await searchRipgrep(scope, options)
  } catch (error: any) {
    if (engine === 'ripgrep' || error?.code !== 'ENOENT') throw error
    return searchBuiltin(scope, options)
  }
}

/** Resolves a user-supplied search directory and refuses symlink or `..` escapes. */
export async function resolveSearchScope(rootInput: string, baseInput: string, displayRootInput?: string): Promise<SearchScope> {
  const root = await realpath(rootInput)
  const base = await realpath(baseInput)
  const scope: SearchScope = { root, base, ...(displayRootInput ? { displayRoot: await realpath(displayRootInput) } : {}) }
  assertScope(scope)
  const info = await lstat(base)
  if (!info.isDirectory()) throw Object.assign(new Error('搜索路径必须是目录'), { code: 'NOT_A_DIRECTORY' })
  return scope
}
