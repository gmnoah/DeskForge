import { describe, expect, it } from 'vitest'
import type { McpServerInput } from '@deskforge/contracts'

import { looksLikeSecretName, mcpSecretValues, mergeMcpSecrets, normalizeMcpServerInput, scrubSecretValues } from './mcp-config'

const stdio = (transport: Partial<Extract<McpServerInput['transport'], { type: 'stdio' }>> = {}, extra: Partial<McpServerInput> = {}): McpServerInput => ({
  name: '本地文件服务', enabled: true, toolNamespace: 'files',
  transport: { type: 'stdio', command: 'npx', args: ['-y', '@example/server'], envKeys: [], ...transport },
  ...extra,
})
const http = (transport: Partial<Extract<McpServerInput['transport'], { type: 'streamable_http' }>> = {}): McpServerInput => ({
  name: '远程服务', enabled: true, toolNamespace: 'remote',
  transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp', auth: 'none', ...transport },
})

describe('MCP config validation', () => {
  it('normalizes stdio servers with plain env, secret env names and cwd modes', () => {
    const normalized = normalizeMcpServerInput(stdio({ env: { LOG_LEVEL: 'debug' }, envKeys: ['GITHUB_TOKEN'] }, { disabledTools: ['delete_repo', 'delete_repo'] }))
    expect(normalized).toEqual({
      name: '本地文件服务', enabled: true, transport: 'stdio',
      config: { type: 'stdio', command: 'npx', args: ['-y', '@example/server'], env: { LOG_LEVEL: 'debug' }, envKeys: ['GITHUB_TOKEN'], cwdMode: 'isolated', toolNamespace: 'files', disabledTools: ['delete_repo'] },
    })
    expect(normalizeMcpServerInput(stdio({ cwdMode: 'workspace' })).config).toMatchObject({ cwdMode: 'workspace' })
    expect(normalizeMcpServerInput(stdio({ cwdMode: 'custom', cwd: '/Users/noah/tools' })).config).toMatchObject({ cwdMode: 'custom', cwd: '/Users/noah/tools' })
  })

  it('rejects plaintext secrets, loader variables and malformed stdio settings with Chinese errors', () => {
    expect(() => normalizeMcpServerInput(stdio({ env: { GITHUB_TOKEN: 'ghp_x' } }))).toThrow('看起来是密钥，请勾选「加密保存」')
    expect(() => normalizeMcpServerInput(stdio({ env: { OPENAI_API_KEY: 'sk' } }))).toThrow('加密保存')
    expect(() => normalizeMcpServerInput(stdio({ env: { DB_PASSWORD: 'x' } }))).toThrow('加密保存')
    expect(() => normalizeMcpServerInput(stdio({ env: { DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' } }))).toThrow('不允许设置环境变量')
    expect(() => normalizeMcpServerInput(stdio({ envKeys: ['NODE_OPTIONS'] }))).toThrow('不允许设置环境变量')
    expect(() => normalizeMcpServerInput(stdio({ env: { 'BAD-NAME': '1' } }))).toThrow('环境变量名无效')
    expect(() => normalizeMcpServerInput(stdio({ env: { API: '1' }, envKeys: ['API'] }))).toThrow('同时出现')
    expect(() => normalizeMcpServerInput(stdio({ envKeys: ['A', 'A'] }))).toThrow('名称重复')
    expect(() => normalizeMcpServerInput(stdio({ command: '  ' }))).toThrow('启动命令 不能为空')
    expect(() => normalizeMcpServerInput(stdio({ command: 'npx\nrm -rf ~' }))).toThrow('换行')
    expect(() => normalizeMcpServerInput(stdio({ args: ['a\nb'] }))).toThrow('第 1 个参数')
    expect(() => normalizeMcpServerInput(stdio({ cwdMode: 'custom', cwd: 'relative/dir' }))).toThrow('绝对路径')
    expect(() => normalizeMcpServerInput(stdio({ cwdMode: 'custom', cwd: '/Users/noah/../../etc' }))).toThrow('..')
    expect(() => normalizeMcpServerInput(stdio({}, { toolNamespace: '1abc' }))).toThrow('工具命名空间')
  })

  it('validates Streamable HTTP URLs, headers and auth combinations', () => {
    expect(normalizeMcpServerInput(http({ headers: { 'X-Tenant': 'acme' }, secretHeaderKeys: ['X-API-Key'], auth: 'headers' })).config).toEqual({
      type: 'streamable_http', url: 'https://mcp.example.com/mcp', auth: 'headers', headers: { 'x-tenant': 'acme' }, secretHeaderKeys: ['x-api-key'], sseFallback: true, toolNamespace: 'remote', disabledTools: [],
    })
    expect(normalizeMcpServerInput(http({ url: 'http://localhost:3333/mcp', sseFallback: false })).config).toMatchObject({ url: 'http://localhost:3333/mcp', sseFallback: false })
    expect(() => normalizeMcpServerInput(http({ url: 'http://mcp.example.com/mcp' }))).toThrow('非本机地址必须使用 HTTPS')
    expect(() => normalizeMcpServerInput(http({ url: 'ftp://mcp.example.com' }))).toThrow('只支持 HTTPS')
    expect(() => normalizeMcpServerInput(http({ url: 'https://user:pw@mcp.example.com' }))).toThrow('不能包含用户名或密码')
    expect(() => normalizeMcpServerInput(http({ url: 'not a url' }))).toThrow('格式不正确')
    expect(() => normalizeMcpServerInput(http({ headers: { Authorization: 'Bearer x' } }))).toThrow('看起来是凭据')
    expect(() => normalizeMcpServerInput(http({ headers: { 'X-Api-Key': 'x' } }))).toThrow('加密保存')
    expect(() => normalizeMcpServerInput(http({ headers: { Host: 'evil' } }))).toThrow('不允许自定义 Header')
    expect(() => normalizeMcpServerInput(http({ headers: { 'X-Note': 'a\r\nX-Injected: 1' } }))).toThrow('不能包含换行')
    expect(() => normalizeMcpServerInput(http({ auth: 'headers' }))).toThrow('至少一个加密 Header')
    expect(() => normalizeMcpServerInput(http({ auth: 'oauth', secretHeaderKeys: ['X-Key'] }))).toThrow('OAuth')
    expect(() => normalizeMcpServerInput(http({ auth: 'bearer', secretHeaderKeys: ['Authorization'] }))).toThrow('Authorization')
  })

  it('detects credential-like names without flagging ordinary ones', () => {
    for (const name of ['GITHUB_TOKEN', 'api_key', 'X-API-Key', 'Authorization', 'SLACK_BOT_TOKEN', 'DB_PASS', 'cookie', 'AWS_SECRET_ACCESS_KEY', 'NOTION_KEY']) expect(looksLikeSecretName(name), name).toBe(true)
    for (const name of ['LOG_LEVEL', 'PATH', 'HOME', 'AUTHOR', 'KEYBOARD_LAYOUT', 'x-tenant', 'accept-language']) expect(looksLikeSecretName(name), name).toBe(false)
  })
})

describe('MCP secret merging', () => {
  const config = (input: McpServerInput) => normalizeMcpServerInput(input).config

  it('stores submitted env secrets, keeps stored ones on empty submission and drops undeclared ones', () => {
    const first = mergeMcpSecrets(config(stdio({ envKeys: ['GITHUB_TOKEN', 'OTHER_KEY'] })), undefined, { env: { GITHUB_TOKEN: 'ghp_one', OTHER_KEY: 'k1' } })
    expect(first).toEqual({ env: { GITHUB_TOKEN: 'ghp_one', OTHER_KEY: 'k1' } })
    const kept = mergeMcpSecrets(config(stdio({ envKeys: ['GITHUB_TOKEN'] })), first, { env: { GITHUB_TOKEN: '' } })
    expect(kept).toEqual({ env: { GITHUB_TOKEN: 'ghp_one' } })
    // Legacy flat blobs written before M3 are still honoured.
    expect(mergeMcpSecrets(config(stdio({ envKeys: ['API_TOKEN'] })), { API_TOKEN: 'legacy' }, undefined)).toEqual({ env: { API_TOKEN: 'legacy' } })
    expect(mergeMcpSecrets(config(stdio()), first, undefined)).toBeUndefined()
    expect(() => mergeMcpSecrets(config(stdio({ envKeys: ['NEW_TOKEN'] })), first, {})).toThrow('请填写加密环境变量 NEW_TOKEN 的值')
    expect(() => mergeMcpSecrets(config(stdio()), undefined, { env: { SNEAKY: 'x' } })).toThrow('未声明的加密环境变量')
  })

  it('handles bearer, secret headers and OAuth ownership for HTTP', () => {
    const bearer = mergeMcpSecrets(config(http({ auth: 'bearer', secretHeaderKeys: ['X-Workspace-Key'] })), undefined, { bearer: ' tok ', headers: { 'x-workspace-key': 'wk' } })
    expect(bearer).toEqual({ bearer: 'tok', headers: { 'x-workspace-key': 'wk' } })
    expect(mergeMcpSecrets(config(http({ auth: 'bearer', secretHeaderKeys: ['X-Workspace-Key'] })), bearer, {})).toEqual(bearer)
    expect(mergeMcpSecrets(config(http({ auth: 'none' })), bearer, undefined)).toBeUndefined()
    expect(mergeMcpSecrets(config(http({ auth: 'oauth' })), { tokens: { access_token: 'a' } }, undefined)).toBe('keep')
    expect(() => mergeMcpSecrets(config(http({ auth: 'oauth' })), undefined, { bearer: 'x' })).toThrow('授权流程')
    expect(() => mergeMcpSecrets(config(http({ auth: 'bearer' })), undefined, {})).toThrow('请填写 Bearer Token')
    expect(() => mergeMcpSecrets(config(http({ auth: 'none' })), undefined, { bearer: 'x' })).toThrow('不使用 Bearer Token')
    expect(() => mergeMcpSecrets(config(http({ auth: 'headers', secretHeaderKeys: ['X-Key'] })), undefined, { headers: { 'X-Key': 'a\nb' } })).toThrow('换行')
  })

  it('scrubs every stored secret value from diagnostic text', () => {
    const values = mcpSecretValues({ env: { A_TOKEN: 'ghp_abcdef' }, bearer: 'bearer-123', tokens: { access_token: 'oauth-xyz' } })
    expect(values).toEqual(expect.arrayContaining(['ghp_abcdef', 'bearer-123', 'oauth-xyz']))
    expect(scrubSecretValues('spawn failed: token=ghp_abcdef auth=bearer-123', values)).toBe('spawn failed: token=[REDACTED] auth=[REDACTED]')
  })
})
