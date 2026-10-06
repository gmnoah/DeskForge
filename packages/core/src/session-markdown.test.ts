import { describe, expect, it } from 'vitest'
import type { RunDetail } from '@deskforge/contracts'
import { renderSessionMarkdown, sessionExportFileName } from './session-markdown'
import { redactForExport } from './secret-redaction'

const at = '2026-10-06T09:30:00.000Z'
const modelKey = ['sk', 'live', 'abcdefghijklmnop1234'].join('-')
const known = 'mcp-secret-value-123'
const githubToken = `ghp_${'A1b2'.repeat(9)}`

function detail(): RunDetail {
  return {
    run: {
      id: 'run_1', workspaceId: 'ws_1', accessMode: 'approval', title: '整理周报 | weekly', objective: '把 docs 下的周报整理成摘要',
      status: 'completed', completionStatus: 'verified',
      model: { profileId: 'p1', provider: 'deepseek', modelId: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', capabilities: {} as never },
      limits: {} as never, modelTurns: 3, createdAt: at, updatedAt: at,
      tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 150 } as never,
    },
    steps: [{ id: 's1', runId: 'run_1', title: '读取周报', ordinal: 0, status: 'completed', createdAt: at, updatedAt: at }],
    messages: [
      { id: 'm1', runId: 'run_1', role: 'user', content: `我的密钥是 ${modelKey}，MCP 用 ${known}`, createdAt: at },
      { id: 'm2', runId: 'run_1', role: 'assistant', content: `已完成。token=${githubToken}\npassword: hunter22`, createdAt: at },
      { id: 'm3', runId: 'run_1', role: 'system', content: 'internal system prompt', createdAt: at },
    ],
    pendingApprovals: [],
    toolCalls: [
      { id: 't1', runId: 'run_1', toolName: 'file_search', status: 'succeeded', riskLevel: 'readonly', argumentsSummary: { query: '周报', limit: 20 }, resultSummary: '找到 3 个文件', sources: [], createdAt: at, updatedAt: at },
      { id: 't2', runId: 'run_1', toolName: 'run_command', status: 'failed', riskLevel: 'high_risk_irreversible', argumentsSummary: { command: `curl -H "Authorization: Bearer ${known}" x|y` }, sources: [], error: { code: 'E', message: '命令失败', retryable: false } as never, createdAt: at, updatedAt: at },
    ],
    approvalHistory: [
      { id: 'a1', runId: 'run_1', toolCallId: 't3', toolName: 'file_edit', riskLevel: 'reversible_write', title: '精确编辑文件', reason: '', target: 'docs/summary.md', arguments: {}, sendsData: [], reversible: true, status: 'approved', createdAt: at, scope: 'session', resolvedAt: at },
      { id: 'a2', runId: 'run_1', toolCallId: 't4', toolName: 'web_fetch', riskLevel: 'external_side_effect', title: '访问网页', reason: '', target: 'https://example.com', arguments: {}, sendsData: ['URL'], reversible: false, status: 'rejected', createdAt: at },
    ],
    artifacts: [{ id: 'f1', kind: 'final_output', sha256: 'a'.repeat(64), mediaType: 'text/markdown', byteLength: 2048, displayName: 'summary.md', createdAt: at }],
    verification: { status: 'verified', checks: [{ name: '文件存在', status: 'passed' }], summary: '已验证输出' },
  }
}

describe('session Markdown export', () => {
  const markdown = renderSessionMarkdown(detail(), { exportedAt: new Date(at), timeZone: 'Asia/Shanghai', workspaceName: 'Demo', knownSecrets: [known] })

  it('redacts known secrets and common credential shapes everywhere', () => {
    for (const secret of [modelKey, known, githubToken, 'hunter22']) expect(markdown).not.toContain(secret)
    expect(markdown).toContain('[REDACTED]')
    expect(markdown).not.toContain('internal system prompt')
  })

  it('summarizes tool calls and approvals readably', () => {
    expect(markdown).toContain('# 整理周报 | weekly')
    expect(markdown).toContain('## 工具调用（2）')
    expect(markdown).toMatch(/\| `file_search` \| 只读 \| 成功 \| query=周报 · limit=20 \| 找到 3 个文件 \|/)
    expect(markdown).toContain('错误：命令失败')
    expect(markdown).toContain('x\\|y')
    expect(markdown).toContain('**精确编辑文件** — 已批准，范围：本会话规则')
    expect(markdown).toContain('**访问网页** — 已拒绝')
    expect(markdown).toContain('外发数据：URL')
    expect(markdown).toContain('2026-10-06 17:30')
    expect(markdown).toContain('- [x] 读取周报')
    expect(markdown).toContain('summary.md · text/markdown · 2.0 KB')
  })

  it('builds safe file names and redacts PEM blocks and URL credentials', () => {
    expect(sessionExportFileName('a/b:c*?', at)).toBe('a b c 2026-10-06.md')
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----'
    expect(redactForExport(`key ${pem} end`)).toBe('key [REDACTED PRIVATE KEY] end')
    expect(redactForExport('postgres://admin:s3cret@db/x')).toBe('postgres://admin:[REDACTED]@db/x')
    expect(redactForExport('AKIAABCDEFGHIJKLMNOP')).toBe('[REDACTED]')
  })
})
