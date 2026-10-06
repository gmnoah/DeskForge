import type { McpCwdMode, McpSecretInput, McpServerInput } from '@deskforge/contracts'

/**
 * MCP server configuration rules shared by the settings form, capability
 * packages and the host. Secret values never live in the normalized config:
 * only their names do, and the values travel in a separately encrypted blob.
 */

export interface McpStoredSecret {
  env?: Record<string, string>
  headers?: Record<string, string>
  bearer?: string
}

export interface NormalizedStdioConfig {
  type: 'stdio'
  command: string
  args: string[]
  env: Record<string, string>
  envKeys: string[]
  cwdMode: McpCwdMode
  cwd?: string
  toolNamespace: string
  disabledTools: string[]
}

export interface NormalizedHttpConfig {
  type: 'streamable_http'
  url: string
  auth: 'none' | 'bearer' | 'headers' | 'oauth'
  headers: Record<string, string>
  secretHeaderKeys: string[]
  sseFallback: boolean
  toolNamespace: string
  disabledTools: string[]
}

export type NormalizedMcpConfig = NormalizedStdioConfig | NormalizedHttpConfig

export interface NormalizedMcpServer {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  config: NormalizedMcpConfig
}

export class McpConfigError extends Error {
  readonly code = 'MCP_CONFIG_INVALID'
}

function fail(message: string): never {
  throw new McpConfigError(message)
}

const MAX_ARGS = 64
const MAX_VALUE = 8_192
const MAX_ENTRIES = 64
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const BLOCKED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const SECRET_NAME = /(?:token|secret|passw(?:or)?d|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credential|cookie|session|authorization|bearer)/i
const SECRET_NAME_PART = /(?:^|[_-])(?:key|auth|pat|pwd|pass)(?:$|[_-])/i

const hasControl = (value: string, allowTab = false): boolean => [...value].some((character) => {
  const code = character.charCodeAt(0)
  return (code <= 0x1f && !(allowTab && code === 0x09)) || code === 0x7f
})

/** Whether a variable or header name conventionally carries a credential. */
export function looksLikeSecretName(name: string): boolean {
  return SECRET_NAME.test(name) || SECRET_NAME_PART.test(name)
}

/** Variables that let a value change how the child loads code; never configurable. */
export function isBlockedEnvName(name: string): boolean {
  return /^(?:LD_|DYLD_)/i.test(name) || /^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|ELECTRON_NO_ATTACH_CONSOLE|PYTHONSTARTUP|PERL5OPT|RUBYOPT|BASH_ENV|ENV)$/i.test(name)
}

function cleanText(value: unknown, label: string, max = 1_024): string {
  if (typeof value !== 'string') fail(`${label} 必须是文本`)
  const text = (value as string).trim()
  if (!text) fail(`${label} 不能为空`)
  if (text.length > max) fail(`${label} 不能超过 ${max} 个字符`)
  if (hasControl(text)) fail(`${label} 不能包含换行或控制字符`)
  return text
}

function uniqueNames(values: unknown, label: string, pattern: RegExp, normalize: (value: string) => string = (value) => value): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) fail(`${label} 必须是列表`)
  const list = values as unknown[]
  if (list.length > MAX_ENTRIES) fail(`${label} 最多 ${MAX_ENTRIES} 项`)
  const seen = new Set<string>()
  return list.map((raw) => {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (!pattern.test(name)) fail(`${label}名称无效：${String(raw)}`)
    const key = normalize(name)
    if (seen.has(key)) fail(`${label}名称重复：${name}`)
    seen.add(key)
    return key
  })
}

function plainMap(value: unknown, label: string): Record<string, string> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${label} 必须是键值对`)
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_ENTRIES) fail(`${label} 最多 ${MAX_ENTRIES} 项`)
  return Object.fromEntries(entries.map(([key, raw]) => {
    if (typeof raw !== 'string') fail(`${label} ${key} 的值必须是文本`)
    if ((raw as string).length > MAX_VALUE) fail(`${label} ${key} 的值过长`)
    return [key.trim(), raw as string]
  }))
}

function validateEnv(env: Record<string, string>, envKeys: string[]): Record<string, string> {
  const secretSet = new Set(envKeys)
  for (const key of envKeys) {
    if (isBlockedEnvName(key)) fail(`不允许设置环境变量 ${key}：它会改变进程加载代码的方式`)
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) fail(`环境变量名无效：${key}`)
    if (isBlockedEnvName(key)) fail(`不允许设置环境变量 ${key}：它会改变进程加载代码的方式`)
    if (secretSet.has(key)) fail(`环境变量 ${key} 同时出现在普通变量和加密变量中`)
    if (value.includes('\u0000')) fail(`环境变量 ${key} 的值包含 NUL 字符`)
    if (looksLikeSecretName(key)) fail(`环境变量 ${key} 看起来是密钥，请勾选「加密保存」，不要以明文保存`)
    result[key] = value
  }
  return result
}

function validateHeaders(headers: Record<string, string>, secretKeys: string[]): Record<string, string> {
  const secretSet = new Set(secretKeys.map((key) => key.toLowerCase()))
  for (const key of secretKeys) {
    if (BLOCKED_HEADERS.has(key.toLowerCase())) fail(`不允许自定义 Header：${key}`)
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(key)) fail(`Header 名称无效：${key}`)
    const lower = key.toLowerCase()
    if (BLOCKED_HEADERS.has(lower)) fail(`不允许自定义 Header：${key}`)
    if (secretSet.has(lower)) fail(`Header ${key} 同时出现在普通 Header 和加密 Header 中`)
    if (hasControl(value, true)) fail(`Header ${key} 的值不能包含换行`)
    if (looksLikeSecretName(key)) fail(`Header ${key} 看起来是凭据，请勾选「加密保存」，不要以明文保存`)
    if (lower in result) fail(`Header 名称重复：${key}`)
    result[lower] = value
  }
  return result
}

function validateUrl(raw: unknown): string {
  const text = cleanText(raw, 'Server URL', 2_048)
  let url: URL
  try { url = new URL(text) } catch { return fail('Server URL 格式不正确，应类似 https://example.com/mcp') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('Server URL 只支持 HTTPS（本机调试可用 http://localhost）')
  if (url.username || url.password) fail('Server URL 不能包含用户名或密码，请改用加密保存的 Header 或 Bearer Token')
  if (url.protocol === 'http:' && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) fail('非本机地址必须使用 HTTPS')
  return url.toString()
}

/** Validates a settings/capability-package submission and returns the config persisted in SQLite. */
export function normalizeMcpServerInput(input: McpServerInput): NormalizedMcpServer {
  const name = cleanText(input.name, '名称', 128)
  const toolNamespace = cleanText(input.toolNamespace, '工具命名空间', 64)
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(toolNamespace)) fail('工具命名空间须以字母开头，只能包含字母、数字、_ 和 -')
  const disabledTools = [...new Set((input.disabledTools ?? []).map((tool) => cleanText(tool, '工具名', 256)))]
  const transport = input.transport
  if (transport.type === 'stdio') {
    const command = cleanText(transport.command, '启动命令', 1_024)
    if (!Array.isArray(transport.args)) fail('参数必须是列表')
    if (transport.args.length > MAX_ARGS) fail(`参数最多 ${MAX_ARGS} 个`)
    const args = transport.args.map((arg, index) => {
      if (typeof arg !== 'string') fail(`第 ${index + 1} 个参数必须是文本`)
      if (arg.length > MAX_VALUE || arg.includes('\u0000') || /[\r\n]/.test(arg)) fail(`第 ${index + 1} 个参数包含换行或过长`)
      return arg
    })
    const envKeys = uniqueNames(transport.envKeys, '加密环境变量', ENV_NAME)
    const env = validateEnv(plainMap(transport.env, '环境变量'), envKeys)
    const cwdMode: McpCwdMode = transport.cwdMode ?? (transport.cwd ? 'custom' : 'isolated')
    if (!['isolated', 'workspace', 'custom'].includes(cwdMode)) fail('工作目录模式无效')
    let cwd: string | undefined
    if (cwdMode === 'custom') {
      cwd = cleanText(transport.cwd, '工作目录', 4_096)
      if (!cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd)) fail('工作目录必须是绝对路径')
      if (cwd.split(/[\\/]/).includes('..')) fail('工作目录不能包含 ..')
    }
    return {
      name,
      enabled: input.enabled !== false,
      transport: 'stdio',
      config: { type: 'stdio', command, args, env, envKeys, cwdMode, ...(cwd ? { cwd } : {}), toolNamespace, disabledTools },
    }
  }
  if (transport.type !== 'streamable_http') return fail('不支持的传输方式')
  const url = validateUrl(transport.url)
  const auth = transport.auth
  if (!['none', 'bearer', 'headers', 'oauth'].includes(auth)) fail('认证方式无效')
  const secretHeaderKeys = uniqueNames(transport.secretHeaderKeys, '加密 Header ', HEADER_NAME, (value) => value.toLowerCase())
  if (auth === 'headers' && secretHeaderKeys.length === 0) fail('「自定义 Header」认证需要至少一个加密 Header')
  if (auth === 'oauth' && secretHeaderKeys.length) fail('OAuth 连接不能同时配置加密 Header')
  if (auth === 'bearer' && secretHeaderKeys.some((key) => key.toLowerCase() === 'authorization')) fail('Bearer Token 已占用 Authorization Header')
  const headers = validateHeaders(plainMap(transport.headers, 'Header'), secretHeaderKeys)
  if ((auth === 'bearer' || auth === 'oauth') && 'authorization' in headers) fail('Authorization Header 由认证方式管理，不能手动填写')
  return {
    name,
    enabled: input.enabled !== false,
    transport: 'http',
    config: { type: 'streamable_http', url, auth, headers, secretHeaderKeys, sseFallback: transport.sseFallback !== false, toolNamespace, disabledTools },
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const stringAt = (source: Record<string, unknown> | undefined, key: string): string | undefined => {
  const value = source?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Builds the secret blob to store after a save. Submitted values win; an empty
 * submission keeps the stored value; names no longer declared are dropped.
 * Returns `undefined` when nothing secret remains (the stored blob is cleared),
 * or `'keep'` for OAuth, whose tokens are owned by the OAuth flow.
 */
export function mergeMcpSecrets(config: NormalizedMcpConfig, existing: unknown, incoming: McpSecretInput | undefined): McpStoredSecret | undefined | 'keep' {
  const previous = record(existing)
  const previousEnv = record(previous?.env)
  const previousHeaders = record(previous?.headers)
  const result: McpStoredSecret = {}
  if (config.type === 'stdio') {
    if (incoming?.headers && Object.keys(incoming.headers).length) fail('stdio 连接不使用 Header')
    for (const key of Object.keys(incoming?.env ?? {})) {
      if (!config.envKeys.includes(key)) fail(`未声明的加密环境变量：${key}`)
    }
    const env: Record<string, string> = {}
    for (const key of config.envKeys) {
      const submitted = incoming?.env?.[key]
      const value = submitted || stringAt(previousEnv, key) || stringAt(previous, key)
      if (!value) fail(`请填写加密环境变量 ${key} 的值`)
      if (value!.includes('\u0000') || value!.length > MAX_VALUE) fail(`环境变量 ${key} 的值无效`)
      env[key] = value!
    }
    if (Object.keys(env).length) result.env = env
    return Object.keys(result).length ? result : undefined
  }
  if (config.auth === 'oauth') {
    if (incoming?.bearer || Object.values(incoming?.headers ?? {}).some(Boolean)) fail('OAuth 连接的令牌通过授权流程获取，不能手动填写')
    return 'keep'
  }
  if (incoming?.env && Object.keys(incoming.env).length) fail('HTTP 连接不使用环境变量')
  const declared = new Map(config.secretHeaderKeys.map((key) => [key.toLowerCase(), key]))
  for (const key of Object.keys(incoming?.headers ?? {})) {
    if (!declared.has(key.toLowerCase())) fail(`未声明的加密 Header：${key}`)
  }
  const headers: Record<string, string> = {}
  for (const [lower, key] of declared) {
    const submitted = Object.entries(incoming?.headers ?? {}).find(([name]) => name.toLowerCase() === lower)?.[1]
    const stored = Object.entries(previousHeaders ?? {}).find(([name]) => name.toLowerCase() === lower)?.[1]
    const value = submitted || (typeof stored === 'string' ? stored : undefined)
    if (!value) fail(`请填写加密 Header ${key} 的值`)
    if (hasControl(value!, true) || value!.length > MAX_VALUE) fail(`Header ${key} 的值不能包含换行`)
    headers[key] = value!
  }
  if (Object.keys(headers).length) result.headers = headers
  if (config.auth === 'bearer') {
    const bearer = incoming?.bearer?.trim() || stringAt(previous, 'bearer') || stringAt(previous, 'token') || stringAt(previous, 'accessToken')
    if (!bearer) fail('请填写 Bearer Token')
    if (/[\r\n]/.test(bearer!)) fail('Bearer Token 不能包含换行')
    result.bearer = bearer!
  } else if (incoming?.bearer) {
    fail('当前认证方式不使用 Bearer Token')
  }
  return Object.keys(result).length ? result : undefined
}

/** Every secret string in a stored blob, longest first, for scrubbing error text. */
export function mcpSecretValues(secret: unknown): string[] {
  const values = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6) return
    if (typeof value === 'string') { if (value.length >= 4) values.add(value); return }
    if (Array.isArray(value)) { value.forEach((entry) => visit(entry, depth + 1)); return }
    const source = record(value)
    if (source) Object.values(source).forEach((entry) => visit(entry, depth + 1))
  }
  visit(secret, 0)
  return [...values].sort((left, right) => right.length - left.length)
}

export function scrubSecretValues(text: string, secrets: string[]): string {
  let output = text
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]')
  return output
}
