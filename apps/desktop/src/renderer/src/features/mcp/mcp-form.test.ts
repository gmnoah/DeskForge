import { describe, expect, it } from 'vitest'

import { normalizeMcp, normalizeMcpTest, normalizeSkill, normalizeSkillPreview } from '../../bridge'
import { buildMcpInput, emptyMcpForm, joinArgs, mcpFormFromServer, mcpFormProblems, splitArgs } from './mcp-form'

describe('MCP settings form', () => {
  it('splits and joins quoted arguments', () => {
    expect(splitArgs(`-y @scope/server --root "My Docs" '' --flag="a b"`)).toEqual(['-y', '@scope/server', '--root', 'My Docs', '', '--flag=a b'])
    expect(() => splitArgs('"unterminated')).toThrow('引号')
    const args = ['-y', 'with space', 'quote"d', '']
    expect(splitArgs(joinArgs(args))).toEqual(args)
  })

  it('keeps secret values out of the plain config and only names in envKeys', () => {
    const form = { ...emptyMcpForm(), name: '文件', namespace: 'files', command: 'npx', args: '-y server', cwdMode: 'workspace' as const, env: [{ key: 'MODE', value: 'demo', secret: false }, { key: 'API_TOKEN', value: 's3cret', secret: true }] }
    expect(mcpFormProblems(form)).toEqual([])
    const input = buildMcpInput(form)
    expect(input).toEqual({
      name: '文件', enabled: true, toolNamespace: 'files',
      transport: { type: 'stdio', command: 'npx', args: ['-y', 'server'], env: { MODE: 'demo' }, envKeys: ['API_TOKEN'], cwdMode: 'workspace' },
      secrets: { env: { API_TOKEN: 's3cret' } },
    })
    expect(JSON.stringify(input.transport)).not.toContain('s3cret')
  })

  it('flags credential-looking plain values and missing secret values', () => {
    const form = { ...emptyMcpForm(), name: 'x', namespace: 'x', command: 'node', env: [{ key: 'GITHUB_TOKEN', value: 'ghp', secret: false }, { key: 'OTHER_SECRET', value: '', secret: true }] }
    const problems = mcpFormProblems(form)
    expect(problems.join('\n')).toContain('GITHUB_TOKEN 看起来是密钥')
    expect(problems.join('\n')).toContain('OTHER_SECRET')
    expect(mcpFormProblems({ ...emptyMcpForm(), name: 'x', namespace: '1x', command: 'node', cwdMode: 'custom' })).toEqual(expect.arrayContaining(['请通过「选择文件夹」指定工作目录']))
  })

  it('builds HTTP payloads with secret headers and bearer tokens', () => {
    const form = { ...emptyMcpForm(), transport: 'http' as const, name: '远程', namespace: 'remote', url: 'https://mcp.example.com/mcp', auth: 'bearer' as const, bearer: 'tok', sseFallback: false, headers: [{ key: 'X-Team', value: 'a', secret: false }, { key: 'X-Api-Key', value: 'k', secret: true }] }
    expect(buildMcpInput(form)).toEqual({
      name: '远程', enabled: true, toolNamespace: 'remote',
      transport: { type: 'streamable_http', url: 'https://mcp.example.com/mcp', auth: 'bearer', headers: { 'X-Team': 'a' }, secretHeaderKeys: ['X-Api-Key'], sseFallback: false },
      secrets: { headers: { 'X-Api-Key': 'k' }, bearer: 'tok' },
    })
  })

  it('round-trips a presented server without exposing or requiring stored secrets', () => {
    const server = normalizeMcp({ id: 'm1', name: 'gh', enabled: false, toolNamespace: 'gh', health: 'healthy', connectedVia: 'stdio', transport: { type: 'stdio', command: 'npx', args: ['-y', 'gh server'], env: { MODE: 'x' }, envKeys: ['GH_TOKEN'], cwdMode: 'custom', cwd: '/work/tools' }, tools: [{ name: 'search', enabled: true, readOnlyHint: true }, { name: 'push', enabled: false }] }, 0)
    expect(server).toMatchObject({ enabled: false, status: 'connected', toolCount: 2, cwdMode: 'custom', cwd: '/work/tools', connectedVia: 'stdio' })
    const form = mcpFormFromServer(server)
    expect(form.env).toEqual([{ key: 'MODE', value: 'x', secret: false }, { key: 'GH_TOKEN', value: '', secret: true, stored: true }])
    expect(mcpFormProblems(form)).toEqual([])
    const input = buildMcpInput(form)
    expect(input).toMatchObject({ id: 'm1', enabled: false, transport: { args: ['-y', 'gh server'], envKeys: ['GH_TOKEN'], cwdMode: 'custom', cwd: '/work/tools' }, secrets: { env: { GH_TOKEN: '' } } })
  })

  it('normalizes connection tests, skills and import previews', () => {
    expect(normalizeMcpTest({ ok: false, error: { message: '超时' } })).toEqual({ ok: false, tools: [], error: '超时' })
    expect(normalizeMcpTest({ ok: true, toolCount: 1, tools: [{ name: 'echo', enabled: true }], connectedVia: 'sse' })).toMatchObject({ ok: true, connectedVia: 'sse', tools: [{ name: 'echo' }] })
    expect(normalizeSkill({ id: 's', name: 'a', description: 'b', enabled: true, directory: '/x/a', source: { kind: 'git', url: 'https://github.com/a/b', commit: 'abc' } }, 0)).toMatchObject({ origin: { kind: 'git', url: 'https://github.com/a/b', commit: 'abc' }, source: '/x/a' })
    const preview = normalizeSkillPreview({ selectionId: 'p', source: { kind: 'folder', path: '/s' }, name: 'n', description: 'd', version: '1.0.0', permissions: [{ capability: 'shell' }], instructionsPreview: '正文', files: [{ path: 'SKILL.md', size: 10, kind: 'entry' }, { path: 'scripts/a.sh', size: 5, kind: 'script' }], fileCount: 2, totalBytes: 15, scriptFiles: ['scripts/a.sh'], warnings: ['w'], replaces: { id: 's', version: '0.9.0', enabled: false } })
    expect(preview).toMatchObject({ origin: { kind: 'folder', path: '/s' }, permissions: ['shell'], scriptFiles: ['scripts/a.sh'], replaces: { id: 's', enabled: false } })
    expect(normalizeSkillPreview(null)).toBeUndefined()
  })
})
