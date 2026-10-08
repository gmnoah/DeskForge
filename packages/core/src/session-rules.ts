import type { RiskLevel } from '@deskforge/contracts'

/**
 * 「本会话总是允许此类操作」: run-scoped auto-approval rules.
 * Only reversible local writes are eligible; destructive, external,
 * sensitive-file and denied operations always need a fresh decision.
 */

export type SessionRuleKind = 'tool' | 'shell_prefix'

export interface SessionRuleSpec {
  kind: SessionRuleKind
  /** Registry tool id, e.g. `file_write` or `shell_run`. */
  toolId: string
  riskLevel: RiskLevel
  /** Space-joined command prefix tokens for `shell_prefix` rules. */
  commandPrefix?: string
  label: string
}

export interface SessionRule extends SessionRuleSpec {
  id: string
  runId: string
  createdAt: string
  revokedAt?: string
}

export interface SessionRuleCandidate {
  runId: string
  toolId: string
  toolLabel?: string
  effect: 'allow' | 'deny' | 'require_approval'
  riskLevel: RiskLevel
  ruleId?: string
  sendsDataOffDevice?: boolean
  command?: string
}

export type SessionRuleEligibility =
  | { eligible: true; spec: SessionRuleSpec }
  | { eligible: false; reason: string }

/** Built-in tools whose reversible writes may be covered by a tool-level rule. */
export const SESSION_RULE_TOOL_IDS = new Set(['file_write', 'file_replace', 'file_draft_commit', 'document_render'])
export const SESSION_RULE_SHELL_TOOL_IDS = new Set(['shell_run'])

const SHELL_METACHARACTERS = /[;&|<>`\n\r(){}\\*?![\]]|\$/
/** Executables that can wrap, escalate, delete, move data off-device or drive other apps. */
export const SESSION_RULE_EXCLUDED_EXECUTABLES = new Set([
  'sudo', 'su', 'doas', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'xargs', 'eval', 'exec', 'command', 'builtin', 'nohup', 'time', 'timeout', 'watch', 'nice',
  'osascript', 'open', 'automator', 'shortcuts', 'ssh', 'scp', 'sftp', 'rsync', 'curl', 'wget', 'nc', 'ncat', 'telnet', 'ftp',
  'rm', 'rmdir', 'mv', 'dd', 'chmod', 'chown', 'chgrp', 'kill', 'killall', 'pkill', 'unlink', 'shred', 'srm', 'trash', 'truncate', 'mkfs', 'diskutil', 'launchctl', 'defaults', 'security', 'crontab',
  'docker', 'podman', 'kubectl', 'helm', 'terraform', 'aws', 'gcloud', 'az', 'gh', 'heroku', 'vercel', 'netlify', 'fly', 'flyctl',
])
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'php', 'deno', 'bun', 'tsx', 'ts-node', 'osascript'])
/** Subcommands that publish, rewrite history, or delete — never covered by a prefix rule. */
const EXCLUDED_SUBCOMMANDS = new Set([
  'publish', 'unpublish', 'deprecate', 'login', 'logout', 'adduser', 'owner', 'token', 'dist-tag', 'deploy', 'release', 'upload',
  'push', 'reset', 'clean', 'rebase', 'checkout', 'restore', 'rm', 'filter-branch', 'filter-repo', 'gc', 'prune', 'reflog', 'stash', 'branch', 'tag', 'remote', 'config', 'submodule', 'worktree', 'update-ref', 'switch',
  'dlx', 'exec', 'x', 'eval', 'shell',
])
const RUN_SUBCOMMANDS = new Set(['run', 'run-script'])
const SUBCOMMAND = /^[a-z][a-z0-9:._-]*$/i
const SCRIPT_PATH = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:py|js|mjs|cjs|ts|mts|rb|pl|php)$/i

export function tokenizeSimpleCommand(command: string): string[] | undefined {
  const trimmed = command.trim()
  if (!trimmed || SHELL_METACHARACTERS.test(trimmed)) return undefined
  const tokens = trimmed.split(/\s+/)
  // Quotes are allowed only after the prefix, so they cannot hide what runs.
  return tokens
}

function stripDirectoryChangePrefix(command: string): string {
  const match = command.match(/^\s*cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/i)
  return match ? command.slice(match[0].length).trim() : command.trim()
}

/** Returns the command prefix a session rule would cover, or a refusal reason. */
export function shellCommandPrefix(command: string): { prefix: string[] } | { reason: string } {
  const normalized = stripDirectoryChangePrefix(command)
  const tokens = tokenizeSimpleCommand(normalized)
  if (!tokens) return { reason: '命令包含管道、重定向、变量或多条命令，不能设为会话规则' }
  const [executable, second] = tokens
  if (!executable || /['"=]/.test(executable) || executable.includes('/') && !/^\.\/[\w.-]+$/.test(executable)) {
    return { reason: '命令以环境变量或路径开头，不能设为会话规则' }
  }
  const name = executable.toLowerCase()
  if (SESSION_RULE_EXCLUDED_EXECUTABLES.has(name)) return { reason: `「${executable}」可能删除数据、提权或访问外部系统，每次都需要确认` }
  if (INTERPRETERS.has(name)) {
    if (!second || !SCRIPT_PATH.test(second) || second.includes('..')) return { reason: '解释器命令必须指向工作区内的脚本文件才能设为会话规则' }
    return { prefix: [executable, second] }
  }
  if (second && SUBCOMMAND.test(second) && !/['"]/.test(second)) {
    if (EXCLUDED_SUBCOMMANDS.has(second.toLowerCase())) return { reason: `「${executable} ${second}」可能发布、改写历史或删除内容，每次都需要确认` }
    if (RUN_SUBCOMMANDS.has(second.toLowerCase())) {
      // `npm run` alone would cover every script, so the script name is part of the prefix.
      const script = tokens[2]
      if (!script || !SUBCOMMAND.test(script)) return { reason: `「${executable} ${second}」需要写明脚本名才能设为会话规则` }
      if (EXCLUDED_SUBCOMMANDS.has(script.toLowerCase())) return { reason: `「${executable} ${second} ${script}」可能发布或删除内容，每次都需要确认` }
      return { prefix: [executable, second, script] }
    }
    return { prefix: [executable, second] }
  }
  // A bare-executable prefix would also match flags followed by a risky subcommand.
  if (tokens.slice(1).some((token) => EXCLUDED_SUBCOMMANDS.has(token.replace(/^['"]|['"]$/g, '').toLowerCase()))) {
    return { reason: '命令参数中包含发布、改写历史或删除类子命令，每次都需要确认' }
  }
  return { prefix: [executable] }
}

export function sessionRuleEligibility(candidate: SessionRuleCandidate): SessionRuleEligibility {
  if (candidate.effect !== 'require_approval') return { eligible: false, reason: candidate.effect === 'deny' ? '已被策略拒绝的操作不能自动批准' : '该操作无需确认' }
  if (candidate.riskLevel === 'high_risk_irreversible') return { eligible: false, reason: '高风险或不可撤销的操作每次都需要确认' }
  if (candidate.riskLevel !== 'reversible_write') return { eligible: false, reason: '会影响外部系统的操作每次都需要确认' }
  if (candidate.sendsDataOffDevice) return { eligible: false, reason: '会发送数据到本机以外的操作每次都需要确认' }
  if (candidate.ruleId?.startsWith('security.')) return { eligible: false, reason: '涉及凭据或敏感配置的操作每次都需要确认' }
  const label = candidate.toolLabel ?? candidate.toolId
  if (SESSION_RULE_SHELL_TOOL_IDS.has(candidate.toolId)) {
    const parsed = shellCommandPrefix(candidate.command ?? '')
    if ('reason' in parsed) return { eligible: false, reason: parsed.reason }
    const commandPrefix = parsed.prefix.join(' ')
    return { eligible: true, spec: { kind: 'shell_prefix', toolId: candidate.toolId, riskLevel: candidate.riskLevel, commandPrefix, label: `以「${commandPrefix}」开头的命令` } }
  }
  if (!SESSION_RULE_TOOL_IDS.has(candidate.toolId)) return { eligible: false, reason: '该类工具每次都需要确认' }
  return { eligible: true, spec: { kind: 'tool', toolId: candidate.toolId, riskLevel: candidate.riskLevel, label: `「${label}」（可撤销的本地写入）` } }
}

/**
 * Finds an active rule that covers this call. The candidate is re-checked for
 * eligibility first, so a rule can never cover a riskier call than it was made for.
 */
export function matchSessionRule(rules: readonly SessionRule[], candidate: SessionRuleCandidate): SessionRule | undefined {
  const eligibility = sessionRuleEligibility(candidate)
  if (!eligibility.eligible) return undefined
  const spec = eligibility.spec
  return rules.find((rule) => {
    if (rule.revokedAt || rule.runId !== candidate.runId || rule.toolId !== candidate.toolId || rule.riskLevel !== candidate.riskLevel || rule.kind !== spec.kind) return false
    if (rule.kind === 'tool') return true
    // The call's own derived prefix must equal the rule's: a rule made for
    // `npm test` never covers `npm install`, and `npm` never covers `npm publish`.
    return Boolean(rule.commandPrefix) && rule.commandPrefix === spec.commandPrefix
  })
}
