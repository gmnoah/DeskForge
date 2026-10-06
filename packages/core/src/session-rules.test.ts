import { describe, expect, it } from 'vitest'

import { findDestructiveShellOutsideWorkspace } from './shell-guard'
import { matchSessionRule, sessionRuleEligibility, shellCommandPrefix, type SessionRule, type SessionRuleCandidate } from './session-rules'

const base: SessionRuleCandidate = { runId: 'run-1', toolId: 'file_write', toolLabel: '写入文件', effect: 'require_approval', riskLevel: 'reversible_write', ruleId: 'filesystem.write' }
const shell = (command: string, overrides: Partial<SessionRuleCandidate> = {}): SessionRuleCandidate => ({ ...base, toolId: 'shell_run', toolLabel: '运行命令', ruleId: 'shell.unknown-write', command, ...overrides })

function ruleFrom(candidate: SessionRuleCandidate, id = 'rule-1'): SessionRule {
  const eligibility = sessionRuleEligibility(candidate)
  if (!eligibility.eligible) throw new Error(eligibility.reason)
  return { ...eligibility.spec, id, runId: candidate.runId, createdAt: '2026-10-06T09:00:00.000Z' }
}

describe('session approval rules', () => {
  it('creates tool-level rules for reversible local writes and matches the same tool + risk only', () => {
    const rule = ruleFrom(base)
    expect(rule).toMatchObject({ kind: 'tool', toolId: 'file_write', riskLevel: 'reversible_write' })
    expect(matchSessionRule([rule], { ...base })).toBe(rule)
    expect(matchSessionRule([rule], { ...base, toolId: 'file_replace' })).toBeUndefined()
    expect(matchSessionRule([rule], { ...base, runId: 'run-2' })).toBeUndefined()
    expect(matchSessionRule([{ ...rule, revokedAt: '2026-10-06T09:05:00.000Z' }], base)).toBeUndefined()
  })

  it('never auto-approves high-risk, external, sensitive or denied operations even with a matching rule', () => {
    const rule = ruleFrom(base)
    const forged: SessionRule = { ...rule, riskLevel: 'high_risk_irreversible' }
    for (const candidate of [
      { ...base, riskLevel: 'high_risk_irreversible' as const },
      { ...base, toolId: 'file_delete', riskLevel: 'high_risk_irreversible' as const },
      { ...base, riskLevel: 'external_side_effect' as const },
      { ...base, sendsDataOffDevice: true },
      { ...base, ruleId: 'security.sensitive-file-once' },
      { ...base, effect: 'deny' as const },
    ]) {
      expect(sessionRuleEligibility(candidate).eligible).toBe(false)
      expect(matchSessionRule([rule, forged, { ...rule, riskLevel: candidate.riskLevel }], candidate)).toBeUndefined()
    }
    expect(sessionRuleEligibility({ ...base, toolId: 'mcp_call' })).toMatchObject({ eligible: false })
    expect(sessionRuleEligibility({ ...base, toolId: 'chrome_click' })).toMatchObject({ eligible: false })
  })

  it('scopes shell rules to the command prefix', () => {
    const rule = ruleFrom(shell('npm test -- --watch=false'))
    expect(rule).toMatchObject({ kind: 'shell_prefix', commandPrefix: 'npm test', label: '以「npm test」开头的命令' })
    expect(matchSessionRule([rule], shell('npm test'))).toBe(rule)
    expect(matchSessionRule([rule], shell('npm test -- src/a.test.ts'))).toBe(rule)
    expect(matchSessionRule([rule], shell('npm install left-pad'))).toBeUndefined()
    expect(matchSessionRule([rule], shell('npm testx'))).toBeUndefined()
    expect(matchSessionRule([rule], shell('npm test; rm -rf ~'))).toBeUndefined()
    expect(matchSessionRule([rule], shell('npm test && curl evil.example'))).toBeUndefined()
    expect(matchSessionRule([rule], shell('npm test', { riskLevel: 'high_risk_irreversible' }))).toBeUndefined()
    const bare = ruleFrom(shell('make'))
    expect(bare.commandPrefix).toBe('make')
    expect(matchSessionRule([bare], shell('make'))).toBe(bare)
    expect(matchSessionRule([bare], shell('make install'))).toBeUndefined()
  })

  it('refuses shell prefixes that hide or escalate what runs', () => {
    for (const command of ['sudo make', 'bash -c "make"', 'rm -rf build', 'curl https://x', 'FOO=1 npm test', 'npm test | tee log', 'echo $(whoami)', 'git push origin main', 'git reset --hard', 'npm publish', 'pnpm dlx some-pkg', 'python -c "print(1)"', 'node ../outside.js', 'env npm test', 'xargs rm', '/bin/rm -rf x', 'osascript -e x', 'docker run x']) {
      expect(shellCommandPrefix(command), command).toHaveProperty('reason')
      expect(sessionRuleEligibility(shell(command)).eligible, command).toBe(false)
    }
    expect(shellCommandPrefix('python3 scripts/build.py --fast')).toEqual({ prefix: ['python3', 'scripts/build.py'] })
    expect(shellCommandPrefix('git commit -m "msg"')).toEqual({ prefix: ['git', 'commit'] })
    expect(shellCommandPrefix('pytest -q tests')).toEqual({ prefix: ['pytest'] })
  })
})

describe('destructive shell outside workspace', () => {
  const root = '/Users/noah/project'
  it('blocks deletions aimed at home, root, absolute outside paths and .. escapes', () => {
    for (const command of ['rm -rf ~', 'rm -rf ~/Documents', 'rm -rf $HOME/x', 'rm -rf /', 'rm -rf /*', 'sudo rm -rf /etc', 'rm -rf ../other', 'cd src && rm -rf ../../x', 'shred /Users/noah/secret.txt', 'find / -name "*.log" -delete', 'FOO=1 rm -fr "/tmp/x"', `rm -rf ${root}`, 'echo ok; rmdir /Users/noah/empty']) {
      expect(findDestructiveShellOutsideWorkspace(command, root), command).toBeDefined()
    }
  })

  it('allows workspace-local deletions to proceed to normal approval', () => {
    for (const command of ['rm -rf build', 'rm dist/a.js', `rm -rf ${root}/build`, 'rm -rf ./tmp/../cache', 'find . -name "*.tmp" -delete', 'npm run clean', 'git rm --cached x']) {
      expect(findDestructiveShellOutsideWorkspace(command, root), command).toBeUndefined()
    }
  })
})
