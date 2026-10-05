const SECRET_KEY = /api[_-]?key|authorization|token|secret|password|credential/i;

/** Drop fields that might carry credentials before they reach the audit log. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(inner);
  }
  return output;
}

export function redactText(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}
