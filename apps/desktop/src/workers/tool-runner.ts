import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import process from 'node:process'
import { parseToolRunnerCommand, WORKER_PROTOCOL_VERSION, type ToolRunnerCommand } from '@deskforge/contracts'

import {
  replaceFileTextSafely,
  resolveAuthorizedPath,
  restoreFileSafely,
  safeFetch,
  safeWebSearch,
  trashFileSafely,
  writeFileSafely,
  writeBinaryFileSafely,
} from './runner-security'
import { findFiles, resolveSearchScope, searchContents } from './workspace-search'
import { callMcpTool, closeAllMcp, disconnectMcp, listMcpTools, sanitizedEnvironment } from './mcp-client'
import { TextDeltaBuffer } from './event-buffer'

type Command = ToolRunnerCommand

type ResultMessage = { type: 'result'; requestId: string; ok: true; result: any } | { type: 'result'; requestId: string; ok: false; error: string; code?: string }

const parent = process.parentPort
if (!parent && process.env.NODE_ENV !== 'test') throw new Error('Tool Runner 必须由 Electron utilityProcess 启动')

interface ForegroundProcessEntry {
  child: ChildProcess
  runId?: string
}
const processes = new Map<string, ForegroundProcessEntry>()
interface ManagedProcessEntry {
  id: string
  runId: string
  child: ChildProcess
  output: Buffer
  status: 'running' | 'succeeded' | 'failed' | 'stopped'
  exitCode?: number
  signal?: NodeJS.Signals | null
  error?: string
  startedAt: string
  finishedAt?: string
  timer: NodeJS.Timeout
}
const managedProcesses = new Map<string, ManagedProcessEntry>()
const MAX_TEXT = 2 * 1024 * 1024
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024
const MAX_BINARY_BYTES = 50 * 1024 * 1024
const MAX_MANAGED_PROCESS_OUTPUT_BYTES = 25 * 1024 * 1024
const MAX_MANAGED_PROCESS_POLL_BYTES = 128 * 1024

let testSink: ((message: Record<string, unknown>) => void) | undefined
export function setTestMessageSink(sink?: (message: Record<string, unknown>) => void): void {
  testSink = sink
}

const send = (message: Record<string, unknown>): void => {
  if (testSink) {
    testSink({ protocolVersion: WORKER_PROTOCOL_VERSION, ...message })
    return
  }
  if (!parent) {
    if (process.env.NODE_ENV === 'test') return
    throw new Error('Tool Runner IPC 不可用')
  }
  parent.postMessage({ protocolVersion: WORKER_PROTOCOL_VERSION, ...message })
}
const hash = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex')
let cachedLoginPath: string | undefined

export function getCachedShellPath(): string {
  if (cachedLoginPath) return cachedLoginPath
  const initialPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    cachedLoginPath = initialPath
    return cachedLoginPath
  }

  try {
    const shell = loginShell()
    const result = spawnSync(shell, ['-lc', 'echo "__DESKFORGE_PATH_START__${PATH}__DESKFORGE_PATH_END__"'], {
      encoding: 'utf8',
      timeout: 3000,
      env: { HOME: process.env.HOME, USER: process.env.USER },
    })
    const match = result.stdout?.match(/__DESKFORGE_PATH_START__([\s\S]*?)__DESKFORGE_PATH_END__/)
    if (match && match[1]?.trim()) {
      cachedLoginPath = match[1].trim()
      return cachedLoginPath
    }
  } catch {
    // fallback
  }

  const commonPaths = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', `${process.env.HOME}/.cargo/bin`, `${process.env.HOME}/.local/bin`]
  const pathSet = new Set(initialPath.split(':'))
  for (const p of commonPaths) {
    if (existsSync(p)) pathSet.add(p)
  }
  cachedLoginPath = Array.from(pathSet).join(':')
  return cachedLoginPath
}

export function sanitizeEnv(): Record<string, string> {
  const env = sanitizedEnvironment()
  env.PATH = getCachedShellPath()
  delete env.ENV
  delete env.BASH_ENV
  delete env.ZDOTDIR
  return env
}

export interface BoundedTextSnapshot {
  text: string
  truncated: boolean
  total: number
  omittedBytes: number
}

/**
 * Retains a fixed-size byte window while a process is running. The first
 * portion is stable and the second portion rolls forward, so diagnostics keep
 * both the command's opening context and its most recent output without ever
 * accumulating the complete stream in memory.
 */
export class BoundedTextCapture {
  private readonly headLimit: number
  private readonly tailLimit: number
  private head = Buffer.alloc(0)
  private tail = Buffer.alloc(0)
  private totalBytes = 0

  constructor(private readonly maxBytes = MAX_PROCESS_OUTPUT_BYTES) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 2) throw new Error('maxBytes 必须是不小于 2 的整数')
    this.headLimit = Math.max(1, Math.floor(maxBytes * 0.75))
    this.tailLimit = maxBytes - this.headLimit
  }

  append(value: Buffer | string): void {
    const input = Buffer.isBuffer(value) ? value : Buffer.from(value)
    this.totalBytes += input.length

    let offset = 0
    if (this.head.length < this.headLimit) {
      const length = Math.min(this.headLimit - this.head.length, input.length)
      if (length > 0) {
        this.head = Buffer.concat([this.head, Buffer.from(input.subarray(0, length))])
        offset = length
      }
    }

    const remainder = input.subarray(offset)
    if (remainder.length === 0) return
    if (remainder.length >= this.tailLimit) {
      this.tail = Buffer.from(remainder.subarray(remainder.length - this.tailLimit))
      return
    }

    const combined = Buffer.concat([this.tail, remainder])
    this.tail = combined.length <= this.tailLimit
      ? combined
      : Buffer.from(combined.subarray(combined.length - this.tailLimit))
  }

  get retainedBytes(): number {
    return this.head.length + this.tail.length
  }

  snapshot(): BoundedTextSnapshot {
    const omittedBytes = Math.max(0, this.totalBytes - this.retainedBytes)
    if (omittedBytes === 0) {
      return {
        text: Buffer.concat([this.head, this.tail]).toString('utf8'),
        truncated: false,
        total: this.totalBytes,
        omittedBytes,
      }
    }
    return {
      text: `${this.head.toString('utf8')}\n\n…[已省略 ${omittedBytes} bytes]…\n\n${this.tail.toString('utf8')}`,
      truncated: true,
      total: this.totalBytes,
      omittedBytes,
    }
  }
}

async function execute(command: Extract<Command, { type: 'execute' }>): Promise<any> {
  const { toolId, args, workspacePath, authorizedRoot } = command
  const authorizationRoot = authorizedRoot ?? workspacePath
  switch (toolId) {
    case 'file.list': {
      const { root, target } = await resolveAuthorizedPath(authorizationRoot, args.path ?? '.', false, workspacePath)
      const entries = await readdir(target, { withFileTypes: true })
      return { root, path: target, entries: entries.slice(0, args.limit ?? 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })) }
    }
    case 'file.read': {
      const { target } = await resolveAuthorizedPath(authorizationRoot, args.path, false, workspacePath)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('目标不是文件')
      if (info.size > MAX_TEXT) throw new Error('文件超过 2 MB；请使用 Shell 或专用工具分段读取')
      const content = await readFile(target, 'utf8')
      return { path: target, content, sha256: hash(content), mtimeMs: info.mtimeMs, size: info.size }
    }
    case 'file.read_binary': {
      const { target } = await resolveAuthorizedPath(authorizationRoot, args.path, false, workspacePath)
      const info = await stat(target)
      if (!info.isFile()) throw new Error('目标不是文件')
      if (info.size > MAX_BINARY_BYTES) throw Object.assign(new Error('二进制文件超过 50 MB'), { code: 'BINARY_TOO_LARGE' })
      const data = await readFile(target)
      return { path: target, data: data.toString('base64'), sha256: hash(data), mtimeMs: info.mtimeMs, size: info.size }
    }
    case 'file.find': {
      const { root, target, relativeBase } = await resolveAuthorizedPath(authorizationRoot, args.path ?? '.', false, workspacePath)
      const scope = await resolveSearchScope(root, target, relativeBase)
      return findFiles(scope, { pattern: String(args.pattern ?? ''), type: args.type === 'directory' || args.type === 'any' ? args.type : 'file', maxResults: args.maxResults })
    }
    case 'file.search': {
      const { root, target, relativeBase } = await resolveAuthorizedPath(authorizationRoot, args.path ?? '.', false, workspacePath)
      const scope = await resolveSearchScope(root, target, relativeBase)
      return searchContents(scope, {
        query: String(args.query ?? ''),
        regex: args.regex === true,
        caseSensitive: args.caseSensitive === true,
        ...(typeof args.glob === 'string' && args.glob.trim() ? { glob: args.glob.trim() } : {}),
        maxResults: args.maxResults,
        maxFileBytes: args.maxFileBytes,
        env: sanitizeEnv(),
        onChild: (child) => { processes.set(command.requestId, { child, runId: command.runId }); return () => { processes.delete(command.requestId) } },
      })
    }
    case 'file.write': {
      return writeFileSafely(authorizationRoot, String(args.path), String(args.content), args.expectedSha256, workspacePath)
    }
    case 'file.write_binary': {
      if (typeof args.data !== 'string') throw new Error('file.write_binary 缺少 Base64 数据')
      const data = Buffer.from(args.data, 'base64')
      if (data.byteLength > MAX_BINARY_BYTES) throw Object.assign(new Error('二进制文件超过 50 MB'), { code: 'BINARY_TOO_LARGE' })
      return writeBinaryFileSafely(authorizationRoot, String(args.path), data, args.expectedSha256, workspacePath)
    }
    case 'file.replace': {
      return replaceFileTextSafely(authorizationRoot, String(args.path), String(args.oldText), String(args.newText), Boolean(args.replaceAll), args.expectedSha256, workspacePath)
    }
    case 'file.restore': {
      if (typeof args.path !== 'string' || typeof args.content !== 'string' || typeof args.createdFile !== 'boolean') throw new Error('file.restore 参数无效')
      return restoreFileSafely(authorizationRoot, args.path, args.content, args.expectedCurrentSha256, args.createdFile, workspacePath, workspacePath)
    }
    case 'file.delete': {
      return trashFileSafely(authorizationRoot, args.path, workspacePath, workspacePath)
    }
    case 'shell.run': {
      const cwd = (await resolveAuthorizedPath(authorizationRoot, args.cwd ?? '.', false, workspacePath)).target
      return runProcess(command.requestId, command.runId, loginShell(), ['-c', String(args.command)], cwd, Math.min(Number(args.timeoutMs ?? 120_000), 600_000))
    }
    case 'process.start': {
      const cwd = (await resolveAuthorizedPath(authorizationRoot, args.cwd ?? '.', false, workspacePath)).target
      return startManagedProcess(command.runId, String(args.command), cwd, Math.min(Number(args.timeoutMs ?? 30 * 60_000), 30 * 60_000))
    }
    case 'process.poll': return pollManagedProcess(command.runId, String(args.processId), Number(args.cursor ?? 0))
    case 'process.stop': return stopManagedProcess(command.runId, String(args.processId))
    case 'web.search': return safeWebSearch(String(args.query), Number(args.maxResults ?? 8))
    case 'web.fetch': return safeFetch(String(args.url))
    case 'mcp.list_tools': {
      if (!command.mcpServer) throw new Error('未找到 MCP Server 配置')
      return listMcpTools(command.mcpServer)
    }
    case 'mcp.call_tool': {
      if (!command.mcpServer) throw new Error('未找到 MCP Server 配置')
      const toolArgs = args.arguments && typeof args.arguments === 'object' && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {}
      return callMcpTool(command.mcpServer, String(args.toolName), toolArgs)
    }
    case 'mcp.disconnect': {
      return { disconnected: await disconnectMcp(String(args.serverId)) }
    }
    default: throw Object.assign(new Error(`未知 Runner 工具：${toolId}`), { code: 'UNKNOWN_TOOL' })
  }
}

function appendManagedOutput(entry: ManagedProcessEntry, channel: 'stdout' | 'stderr', chunk: Buffer): void {
  if (entry.status !== 'running') return
  const tagged = Buffer.concat([Buffer.from(`\n[${channel}]\n`), chunk])
  if (entry.output.byteLength + tagged.byteLength > MAX_MANAGED_PROCESS_OUTPUT_BYTES) {
    entry.error = '后台进程输出超过 25 MB 上限'
    entry.status = 'failed'
    try { if (entry.child.pid) process.kill(-entry.child.pid, 'SIGTERM') } catch { /* already exited */ }
    return
  }
  entry.output = Buffer.concat([entry.output, tagged])
}

export function loginShell(): string {
  const candidates = process.platform === 'darwin'
    ? ['/bin/zsh', '/bin/bash', '/bin/sh']
    : [process.env.SHELL, '/bin/bash', '/bin/sh', '/bin/zsh']
  return candidates.find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0 && existsSync(candidate)) ?? '/bin/sh'
}

export function startManagedProcess(runId: string, command: string, cwd: string, timeoutMs: number): Record<string, unknown> {
  const active = [...managedProcesses.values()].filter((entry) => entry.runId === runId && entry.status === 'running')
  if (active.length >= 3) throw Object.assign(new Error('当前任务最多同时运行 3 个后台进程'), { code: 'PROCESS_CONCURRENCY_LIMIT' })
  for (const [id, entry] of managedProcesses) {
    if (entry.status !== 'running' && entry.finishedAt && Date.now() - Date.parse(entry.finishedAt) > 10 * 60_000) managedProcesses.delete(id)
  }
  const processId = randomUUID()
  const child = spawn(loginShell(), ['-c', command], { cwd, env: sanitizeEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry: ManagedProcessEntry = {
    id: processId, runId, child, output: Buffer.alloc(0), status: 'running', startedAt: new Date().toISOString(),
    timer: setTimeout(() => {
      if (entry.status !== 'running') return
      entry.error = `后台进程超时（${timeoutMs} ms）`
      entry.status = 'failed'
      try { if (child.pid) process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ }
    }, timeoutMs),
  }
  managedProcesses.set(processId, entry)
  child.stdout?.on('data', (chunk: Buffer) => appendManagedOutput(entry, 'stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => appendManagedOutput(entry, 'stderr', chunk))
  child.on('error', (error) => {
    clearTimeout(entry.timer); entry.status = 'failed'; entry.error = error.message; entry.finishedAt = new Date().toISOString()
  })
  child.on('close', (code, signal) => {
    clearTimeout(entry.timer)
    if (code !== null) entry.exitCode = code
    entry.signal = signal
    if (entry.status === 'running') entry.status = code === 0 ? 'succeeded' : 'failed'
    if (entry.status === 'failed' && !entry.error && code !== 0) entry.error = `进程退出码 ${code}${signal ? ` (${signal})` : ''}`
    entry.finishedAt = new Date().toISOString()
  })
  return { processId, pid: child.pid, status: entry.status, startedAt: entry.startedAt, timeoutMs, cwd }
}

function managedProcess(runId: string, processId: string): ManagedProcessEntry {
  const entry = managedProcesses.get(processId)
  if (!entry || entry.runId !== runId) throw Object.assign(new Error('后台进程不存在或不属于当前任务'), { code: 'PROCESS_NOT_FOUND' })
  return entry
}

export function pollManagedProcess(runId: string, processId: string, cursorInput: number): Record<string, unknown> {
  const entry = managedProcess(runId, processId)
  const cursor = Number.isSafeInteger(cursorInput) ? Math.max(0, Math.min(cursorInput, entry.output.byteLength)) : 0
  const end = Math.min(entry.output.byteLength, cursor + MAX_MANAGED_PROCESS_POLL_BYTES)
  const output = entry.output.subarray(cursor, end).toString('utf8')
  const terminal = entry.status !== 'running'
  return {
    processId, status: entry.status, output, cursor, nextCursor: end, totalBytes: entry.output.byteLength,
    hasMore: end < entry.output.byteLength,
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    ...(entry.signal ? { signal: entry.signal } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.finishedAt ? { finishedAt: entry.finishedAt } : {}),
    ...(terminal ? { fullOutput: entry.output.toString('utf8') } : {}),
  }
}

export function stopManagedProcess(runId: string, processId: string): Record<string, unknown> {
  const entry = managedProcess(runId, processId)
  if (entry.status !== 'running') return { processId, status: entry.status, alreadyStopped: true }
  entry.status = 'stopped'
  entry.finishedAt = new Date().toISOString()
  clearTimeout(entry.timer)
  try { if (entry.child.pid) process.kill(-entry.child.pid, 'SIGTERM') } catch { /* already exited */ }
  return { processId, status: 'stopped', stoppedAt: entry.finishedAt }
}

export function runProcess(requestId: string, runId: string, executable: string, args: string[], cwd: string, timeoutMs: number): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd, env: sanitizeEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    processes.set(requestId, { child, runId })
    const stdout = new BoundedTextCapture()
    const stderr = new BoundedTextCapture()
    let settled = false

    const stdoutBuffer = new TextDeltaBuffer((delta) => {
      send({ type: 'progress', requestId, channel: 'stdout', text: delta })
    }, 50, 8192)
    const stderrBuffer = new TextDeltaBuffer((delta) => {
      send({ type: 'progress', requestId, channel: 'stderr', text: delta })
    }, 50, 8192)

    const timer = setTimeout(() => {
      stdoutBuffer.flush()
      stderrBuffer.flush()
      try { process.kill(-child.pid!, 'SIGTERM') } catch { /* The process may have exited between timeout and signal delivery. */ }
      reject(new Error(`命令超时（${timeoutMs} ms）`))
    }, timeoutMs)

    const collect = (stream: NodeJS.ReadableStream | null, channel: 'stdout' | 'stderr', buffer: TextDeltaBuffer): void => {
      stream?.on('data', (chunk: Buffer) => {
        if (channel === 'stdout') stdout.append(chunk); else stderr.append(chunk)
        buffer.push(chunk.toString('utf8'))
      })
    }
    collect(child.stdout, 'stdout', stdoutBuffer)
    collect(child.stderr, 'stderr', stderrBuffer)

    child.on('error', (error) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        stdoutBuffer.flush()
        stderrBuffer.flush()
        processes.delete(requestId)
        reject(error)
      }
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdoutBuffer.flush()
      stderrBuffer.flush()
      processes.delete(requestId)
      const out = stdout.snapshot()
      const err = stderr.snapshot()
      if (code !== 0) reject(Object.assign(new Error(`命令退出码 ${code}${signal ? ` (${signal})` : ''}\n${err.text || out.text}`), { code: 'COMMAND_FAILED', details: { code, signal, stdout: out, stderr: err } }))
      else resolvePromise({
        code: code ?? 0,
        signal,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        stdoutOmittedBytes: out.omittedBytes,
        stderrOmittedBytes: err.omittedBytes,
        totalBytes: out.total + err.total,
      })
    })
  })
}

parent?.on('message', async (event: { data: unknown }) => {
  let command: Command
  try { command = parseToolRunnerCommand(event.data) } catch (error) { console.error('Invalid Tool Runner IPC', error); return }
  if (command.type === 'cancel') {
    const entry = processes.get(command.requestId)
    if (entry?.child?.pid) {
      try { process.kill(-entry.child.pid, 'SIGTERM') } catch { /* The process may already be gone. */ }
    }
    return
  }
  if (command.type === 'cancel-run') {
    for (const entry of managedProcesses.values()) {
      if (entry.runId === command.runId && entry.status === 'running') stopManagedProcess(command.runId, entry.id)
    }
    for (const [reqId, entry] of processes.entries()) {
      if (entry.runId === command.runId) {
        if (entry.child.pid) {
          try { process.kill(-entry.child.pid, 'SIGTERM') } catch { /* The process may already be gone. */ }
        }
        processes.delete(reqId)
      }
    }
    return
  }
  try {
    const result = await execute(command)
    send({ type: 'result', requestId: command.requestId, ok: true, result } satisfies ResultMessage)
  } catch (error: any) {
    send({ type: 'result', requestId: command.requestId, ok: false, error: error instanceof Error ? error.message : String(error), code: error?.code, details: error?.details } satisfies ResultMessage & { details?: unknown })
  }
})

process.on('exit', () => {
  for (const entry of managedProcesses.values()) {
    clearTimeout(entry.timer)
    try { if (entry.child.pid) process.kill(-entry.child.pid, 'SIGTERM') } catch { /* already exited */ }
  }
  for (const entry of processes.values()) {
    try { if (entry.child.pid) process.kill(-entry.child.pid, 'SIGTERM') } catch { /* already exited */ }
  }
  void closeAllMcp()
})
