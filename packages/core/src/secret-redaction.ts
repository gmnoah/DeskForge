
const KEY_SHAPED_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/g
const BEARER_SECRET = /(authorization\s*[:=]\s*bearer\s+)[^\s,;"']+/gi
const NAMED_SECRET = /((?:api[_-]?key|token|secret)\s*[:=]\s*)[^\s,;"']+/gi

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : '模型请求失败'
}

/** Redact runtime-known secret values before text crosses a process or UI boundary. */
export function redactSecrets(value: unknown, secrets: readonly string[] = []): string {
  let text = errorText(value)
  for (const secret of secrets) {
    if (secret.length >= 4) text = text.replaceAll(secret, '[REDACTED]')
  }
  text = text.replace(KEY_SHAPED_SECRET, '[REDACTED]')
  text = text.replace(BEARER_SECRET, '$1[REDACTED]')
  text = text.replace(NAMED_SECRET, '$1[REDACTED]')
  return text
}

const EXPORT_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED]'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/((?:password|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;"']+/gi, '$1[REDACTED]'],
  [/("(?:api[_-]?key|token|secret|password|authorization)"\s*:\s*")[^"]*(")/gi, '$1[REDACTED]$2'],
]

/**
 * Stricter redaction for content leaving the app (exports, shared reports):
 * known secret values plus common credential shapes.
 */
export function redactForExport(value: string, secrets: readonly string[] = []): string {
  let text = redactSecrets(value, secrets)
  for (const [pattern, replacement] of EXPORT_PATTERNS) text = text.replace(pattern, replacement)
  return text
}
