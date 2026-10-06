import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { SkillImportFile, SkillImportPreview, SkillImportSource, SkillManifest, SkillPermission, SkillSource } from '@deskforge/contracts'

import { parseSkillMarkdown, SKILL_IGNORED_ENTRIES, type ParsedSkill, type SkillService } from './skill-service'

/**
 * Two-phase Skill import: inspect a local folder or a shallow git clone,
 * show the user exactly what will be installed, then copy on confirmation.
 * Nothing from the package is executed at any point.
 */

export const SKILL_IMPORT_LIMITS = {
  maxFiles: 2_048,
  maxTotalBytes: 50 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  maxListedFiles: 300,
  selectionTtlMs: 15 * 60_000,
  cloneTimeoutMs: 120_000,
} as const

export interface SkillInspection {
  root: string
  parsed: ParsedSkill
  files: SkillImportFile[]
  totalBytes: number
  fingerprint: string
  hiddenFiles: string[]
}

export class SkillImportError extends Error {
  readonly code = 'SKILL_IMPORT_INVALID'
}
function fail(message: string): never {
  throw new SkillImportError(message)
}

const within = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

const hasControl = (value: string): boolean => [...value].some((character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f)

const fileKind = (path: string): SkillImportFile['kind'] => {
  if (path === 'SKILL.md') return 'entry'
  if (path.startsWith('scripts/')) return 'script'
  if (path.startsWith('references/') || path.startsWith('reference/')) return 'reference'
  return 'asset'
}

/**
 * Walks a candidate skill folder without following links. Any symlink, device
 * or oversized file rejects the whole package, so nothing outside the folder
 * can be pulled in at copy time.
 */
export async function inspectSkillDirectory(directory: string): Promise<SkillInspection> {
  const requested = resolve(directory)
  let rootInfo
  try { rootInfo = await lstat(requested) } catch { return fail(`找不到文件夹：${directory}`) }
  if (rootInfo.isSymbolicLink()) fail('Skill 文件夹本身不能是符号链接，请选择链接指向的真实文件夹')
  if (!rootInfo.isDirectory()) fail('请选择包含 SKILL.md 的文件夹')
  const root = await realpath(requested)

  const files: Array<SkillImportFile & { sha256: string }> = []
  const hiddenFiles: string[] = []
  let totalBytes = 0
  const visit = async (absolute: string, relativeDir: string): Promise<void> => {
    const entries = await readdir(absolute, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (SKILL_IGNORED_ENTRIES.has(entry.name)) continue
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name
      if (hasControl(entry.name) || entry.name.includes('\\')) fail(`文件名包含不支持的字符：${JSON.stringify(relativePath)}`)
      const path = join(absolute, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) fail(`Skill 包不能包含符号链接：${relativePath}`)
      if (!within(root, path)) fail(`Skill 包路径越界：${relativePath}`)
      if (entry.name.startsWith('.')) hiddenFiles.push(relativePath)
      if (info.isDirectory()) { await visit(path, relativePath); continue }
      if (!info.isFile()) fail(`Skill 包含不支持的文件类型（设备、管道或套接字）：${relativePath}`)
      if (info.size > SKILL_IMPORT_LIMITS.maxFileBytes) fail(`文件超过 10 MB：${relativePath}`)
      totalBytes += info.size
      if (totalBytes > SKILL_IMPORT_LIMITS.maxTotalBytes) fail('Skill 包总大小不能超过 50 MB')
      if (files.length + 1 > SKILL_IMPORT_LIMITS.maxFiles) fail(`Skill 包文件数不能超过 ${SKILL_IMPORT_LIMITS.maxFiles}`)
      const content = await readFile(path)
      files.push({ path: relativePath, size: info.size, kind: fileKind(relativePath), sha256: createHash('sha256').update(content).digest('hex') })
    }
  }
  await visit(root, '')

  const entry = files.find((file) => file.path === 'SKILL.md')
  if (!entry) fail('缺少 SKILL.md：请选择根目录包含 SKILL.md 的文件夹')
  if (entry!.size > SKILL_IMPORT_LIMITS.maxEntryBytes) fail('SKILL.md 超过 1 MB 限制')
  const raw = await readFile(join(root, 'SKILL.md'), 'utf8')
  const parsed = parseSkillMarkdown(raw, root.split(sep).at(-1) ?? 'skill', true)
  const fingerprint = createHash('sha256').update(JSON.stringify(files.map((file) => [file.path, file.sha256]))).digest('hex')
  return { root, parsed, files: files.map(({ sha256: _sha, ...file }) => file), totalBytes, fingerprint, hiddenFiles }
}

/** Only anonymous HTTPS remotes: no ssh/file/git protocols, no embedded credentials. */
export function validateGitUrl(input: string): URL {
  const text = input.trim()
  if (/^git@|^ssh:|^git:|^file:/i.test(text)) fail('只支持 https:// 开头的 Git 仓库地址')
  let url: URL
  try { url = new URL(text) } catch { return fail('Git 仓库地址格式不正确，应类似 https://github.com/owner/repo') }
  if (url.protocol !== 'https:') fail('只支持 https:// 开头的 Git 仓库地址')
  if (url.username || url.password) fail('仓库地址不能包含用户名、密码或令牌')
  if (!url.hostname || url.hostname === 'localhost' || /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(url.hostname) || url.hostname.startsWith('[')) fail('仓库地址必须是公开的 HTTPS 主机')
  if (url.search || url.hash) fail('仓库地址不能包含查询参数或 #')
  return url
}

export function validateGitRef(input?: string): string | undefined {
  const ref = input?.trim()
  if (!ref) return undefined
  if (ref.length > 200 || !/^[A-Za-z0-9._/-]+$/.test(ref) || ref.startsWith('-') || ref.startsWith('/') || ref.endsWith('/') || ref.includes('..') || ref.endsWith('.lock') || ref.includes('//')) {
    fail(`分支或标签名无效：${ref}`)
  }
  return ref
}

/** Repository-relative folder; rejects absolute paths and `..` before touching disk. */
export function normalizeSkillSubpath(input?: string): string | undefined {
  const raw = input?.trim()
  if (!raw || raw === '.' || raw === '/') return undefined
  if (raw.includes('\0') || raw.includes('\\') || hasControl(raw)) fail('子目录包含不支持的字符')
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) fail('子目录必须是仓库内的相对路径')
  const segments = raw.replace(/\/+$/, '').split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) fail('子目录不能包含 ..、. 或空段')
  return segments.join('/')
}

/** Resolves `subpath` inside a clone, refusing symlinked segments and escapes. */
export async function resolveRepositorySubpath(repository: string, subpath?: string): Promise<string> {
  const root = await realpath(repository)
  if (!subpath) return root
  let current = root
  for (const segment of subpath.split('/')) {
    current = join(current, segment)
    let info
    try { info = await lstat(current) } catch { return fail(`仓库中找不到子目录：${subpath}`) }
    if (info.isSymbolicLink()) fail(`子目录路径中包含符号链接：${relative(root, current)}`)
    if (!info.isDirectory()) fail(`子目录不是文件夹：${subpath}`)
  }
  const canonical = await realpath(current)
  if (!within(root, canonical)) fail('子目录越出了仓库范围')
  return canonical
}

export function gitCloneArgs(url: string, ref: string | undefined, destination: string): string[] {
  return [
    // Hermetic, non-executing clone: no hooks, no fsmonitor, no submodules, HTTPS only.
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'submodule.recurse=false',
    '-c', 'credential.helper=',
    'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
    ...(ref ? ['--branch', ref] : []),
    '--', url, destination,
  ]
}

export function gitEnvironment(source: NodeJS.ProcessEnv, home: string): Record<string, string> {
  const passthrough = ['PATH', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR']
  const env: Record<string, string> = {}
  for (const key of passthrough) if (source[key]) env[key] = source[key]!
  return {
    ...env,
    HOME: home,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_PROTOCOL_FROM_USER: '0',
  }
}

export type GitCloner = (input: { url: string; ref?: string; destination: string }) => Promise<{ commit?: string }>

function describeGitError(error: unknown, ref?: string): string {
  const err = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean }
  if (err?.code === 'ENOENT') return '未找到 git 命令。请先安装 Git（macOS 可运行 xcode-select --install）'
  if (err?.killed) return '克隆超时（120 秒），请检查网络或仓库大小'
  const text = String(err?.stderr ?? err?.message ?? error)
  if (ref && /Remote branch .* not found|couldn't find remote ref/i.test(text)) return `仓库中找不到分支或标签：${ref}`
  if (/could not resolve host|unable to access/i.test(text)) return '无法连接仓库主机，请检查网络或代理设置'
  if (/Authentication failed|terminal prompts disabled|could not read Username|repository .* not found|not found/i.test(text)) return '仓库不存在或需要登录；目前只支持无需登录的公开 HTTPS 仓库'
  return `克隆失败：${text.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)}`
}

export function createGitCloner(options: { git?: string; timeoutMs?: number } = {}): GitCloner {
  const git = options.git ?? 'git'
  const run = (args: string[], env: Record<string, string>): Promise<string> => new Promise((resolvePromise, reject) => {
    execFile(git, args, { env, timeout: options.timeoutMs ?? SKILL_IMPORT_LIMITS.cloneTimeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr }))
      else resolvePromise(stdout)
    })
  })
  return async ({ url, ref, destination }) => {
    const env = gitEnvironment(process.env, destination)
    try {
      await run(gitCloneArgs(url, ref, join(destination, 'repo')), env)
      const commit = (await run(['-C', join(destination, 'repo'), 'rev-parse', 'HEAD'], env)).trim()
      return /^[0-9a-f]{40,64}$/.test(commit) ? { commit } : {}
    } catch (error) {
      throw new SkillImportError(describeGitError(error, ref))
    }
  }
}

const PERMISSION_WARNINGS: Partial<Record<SkillPermission['capability'], string>> = {
  shell: '声明了「Shell」权限：运行命令时仍需你逐次批准',
  network: '声明了「联网」权限：联网读取或发送时仍受审批约束',
  browser: '声明了「浏览器」权限：只能操作你绑定的标签页',
  mcp: '声明了「MCP」权限：调用 MCP 工具时仍需你批准',
  filesystem_write: '声明了「写入文件」权限：写入工作区前仍需你批准',
}

interface Selection {
  inspection: SkillInspection
  source: SkillImportSource
  temporary?: string
  expiresAt: number
}

export class SkillImportService {
  private readonly selections = new Map<string, Selection>()
  private readonly cloner: GitCloner

  constructor(
    private readonly skills: SkillService,
    private readonly options: { tempRoot: string; cloner?: GitCloner; now?: () => number },
  ) {
    this.cloner = options.cloner ?? createGitCloner()
  }

  private now(): number { return this.options.now?.() ?? Date.now() }

  async previewFolder(directory: string): Promise<SkillImportPreview> {
    const inspection = await inspectSkillDirectory(directory)
    return this.select(inspection, { kind: 'folder', path: inspection.root })
  }

  async previewGit(input: { url: string; ref?: string; subpath?: string }): Promise<SkillImportPreview> {
    const url = validateGitUrl(input.url)
    const ref = validateGitRef(input.ref)
    const subpath = normalizeSkillSubpath(input.subpath)
    await mkdir(this.options.tempRoot, { recursive: true, mode: 0o700 })
    const temporary = await mkdtemp(join(this.options.tempRoot, 'git-'))
    try {
      const { commit } = await this.cloner({ url: url.toString(), ...(ref ? { ref } : {}), destination: temporary })
      const directory = await resolveRepositorySubpath(join(temporary, 'repo'), subpath)
      const inspection = await inspectSkillDirectory(directory)
      return this.select(inspection, { kind: 'git', url: url.toString(), ...(ref ? { ref } : {}), ...(subpath ? { subpath } : {}), ...(commit ? { commit } : {}) }, temporary)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }

  /** Re-inspects the recorded source of an installed skill. */
  async previewUpdate(id: string): Promise<SkillImportPreview> {
    const installed = (await this.skills.list()).find((skill) => skill.id === id)
    if (!installed) fail('Skill 不存在')
    const source = installed!.source
    if (!source || source.kind === 'bundled') fail('内置 Skill 随应用更新，不能从来源重新导入')
    const preview = source!.kind === 'folder'
      ? await this.previewFolder(source!.path).catch((error) => { throw new SkillImportError(`无法从原文件夹更新：${error instanceof Error ? error.message : String(error)}`) })
      : await this.previewGit({ url: source!.url, ...(source!.ref ? { ref: source!.ref } : {}), ...(source!.subpath ? { subpath: source!.subpath } : {}) })
    if (preview.name !== installed!.name) {
      await this.cancel(preview.selectionId)
      fail(`来源中的 Skill 名称已变为 ${preview.name}，与已安装的 ${installed!.name} 不一致`)
    }
    return preview
  }

  async confirm(selectionId: string): Promise<SkillManifest> {
    const selection = this.selections.get(selectionId)
    this.selections.delete(selectionId)
    if (!selection) fail('导入预览已失效，请重新选择')
    try {
      if (selection!.expiresAt < this.now()) fail('导入预览已过期，请重新选择')
      const current = await inspectSkillDirectory(selection!.inspection.root)
      if (current.fingerprint !== selection!.inspection.fingerprint) fail('Skill 文件在预览后发生了变化，请重新预览')
      const importedAt = new Date(this.now()).toISOString()
      const source: SkillSource = selection!.source.kind === 'folder'
        ? { kind: 'folder', path: selection!.source.path, importedAt }
        : { ...selection!.source, importedAt }
      return await this.skills.importDirectory(current.root, { source, strict: true })
    } finally {
      if (selection?.temporary) await rm(selection.temporary, { recursive: true, force: true })
    }
  }

  async cancel(selectionId: string): Promise<void> {
    const selection = this.selections.get(selectionId)
    this.selections.delete(selectionId)
    if (selection?.temporary) await rm(selection.temporary, { recursive: true, force: true })
  }

  /** Drops expired selections and their clones. */
  async sweep(): Promise<void> {
    for (const [id, selection] of this.selections) if (selection.expiresAt < this.now()) await this.cancel(id)
  }

  private async select(inspection: SkillInspection, source: SkillImportSource, temporary?: string): Promise<SkillImportPreview> {
    await this.sweep()
    const selectionId = randomUUID()
    const expiresAt = this.now() + SKILL_IMPORT_LIMITS.selectionTtlMs
    this.selections.set(selectionId, { inspection, source, ...(temporary ? { temporary } : {}), expiresAt })
    const { parsed } = inspection
    const scriptFiles = inspection.files.filter((file) => file.kind === 'script').map((file) => file.path)
    const existing = this.skills.findByName(parsed.name)
    const warnings = [
      ...(scriptFiles.length ? [`包含 ${scriptFiles.length} 个脚本文件：导入时不会执行；Agent 若要运行，仍需你逐次批准`] : []),
      ...parsed.permissions.map((permission) => PERMISSION_WARNINGS[permission.capability]).filter((text): text is string => Boolean(text)),
      ...(inspection.hiddenFiles.length ? [`包含隐藏文件：${inspection.hiddenFiles.slice(0, 5).join('、')}${inspection.hiddenFiles.length > 5 ? ' 等' : ''}，请确认来源可信`] : []),
      ...(existing ? [`将覆盖已安装的同名 Skill（v${existing.version}），启用状态保持不变`] : []),
    ]
    return {
      selectionId,
      expiresAt: new Date(expiresAt).toISOString(),
      source,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      permissions: parsed.permissions,
      instructionsPreview: parsed.instructions.slice(0, 1_200),
      files: inspection.files.slice(0, SKILL_IMPORT_LIMITS.maxListedFiles),
      fileCount: inspection.files.length,
      totalBytes: inspection.totalBytes,
      scriptFiles,
      warnings,
      ...(existing ? { replaces: { id: existing.id, version: existing.version, enabled: existing.enabled } } : {}),
    }
  }
}
