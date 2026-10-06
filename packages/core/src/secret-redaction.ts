
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
