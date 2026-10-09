const INTERNAL_ARTIFACT_KINDS = new Set(['attachment', 'file_snapshot', 'checkpoint'])

export function isUserVisibleArtifact(artifact: {
  kind?: string | undefined
  mime?: unknown
  mediaType?: unknown
}): boolean {
  const kind = String(artifact.kind ?? '')
  if (INTERNAL_ARTIFACT_KINDS.has(kind) || kind === 'diff') return false
  if (kind === 'final_output') return true
  const mediaType = String(artifact.mime ?? artifact.mediaType ?? '')
  return kind === 'tool_result' && mediaType.startsWith('image/')
}

export function isHtmlArtifact(artifact: {
  name?: string | undefined
  fileName?: string | undefined
  sourcePath?: string | undefined
  path?: string | undefined
  mime?: unknown
}): boolean {
  const candidates = [artifact.fileName, artifact.name, artifact.sourcePath, artifact.path]
    .filter((s): s is string => typeof s === 'string' && Boolean(s))
    .map((s) => s.toLowerCase())
  return candidates.some((c) => c.endsWith('.html') || c.endsWith('.htm') || c.endsWith('.xhtml'))
    || artifact.mime === 'text/html'
}
