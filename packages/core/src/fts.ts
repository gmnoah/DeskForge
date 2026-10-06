/**
 * Query planning for SQLite FTS5 tables that use the `trigram` tokenizer.
 *
 * Trigram indexes match any substring of three or more characters, which makes
 * Chinese text searchable without a word segmenter. Shorter terms (most
 * two-character Chinese words, or "UI") cannot use the index, so they fall
 * back to a LIKE filter on the same rows.
 */

export interface FtsQueryPlan {
  /** Normalized, de-duplicated search terms. */
  terms: string[]
  /** FTS5 MATCH expression for terms with at least three characters. */
  match?: string
  /** Terms too short for the trigram index; filter with LIKE. */
  likeTerms: string[]
}

const MAX_TERMS = 8
const MAX_TERM_CHARS = 64

export function charLength(value: string): number {
  return [...value].length
}

export function planFtsQuery(input: string): FtsQueryPlan {
  const normalized = input.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ')
  // Split on whitespace and FTS / punctuation characters; keep CJK runs intact.
  const raw = normalized.split(/[\s"'`()[\]{}*^:+\-,，。、；;！!？?|<>《》「」『』“”‘’]+/u)
  const terms: string[] = []
  const seen = new Set<string>()
  for (const part of raw) {
    const term = [...part.trim()].slice(0, MAX_TERM_CHARS).join('')
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= MAX_TERMS) break
  }
  const indexed = terms.filter((term) => charLength(term) >= 3)
  const likeTerms = terms.filter((term) => charLength(term) < 3)
  return {
    terms,
    likeTerms,
    ...(indexed.length ? { match: indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(' AND ') } : {}),
  }
}

/** LIKE pattern with `\` as the escape character. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/** Short excerpt around the first matching term, on one line. */
export function excerptAround(text: string, terms: string[], radius = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const lower = flat.toLowerCase()
  let index = -1
  for (const term of terms) {
    const found = lower.indexOf(term.toLowerCase())
    if (found >= 0 && (index < 0 || found < index)) index = found
  }
  if (index < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat
  const start = Math.max(0, index - radius)
  const end = Math.min(flat.length, index + radius)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

/** Case-insensitive occurrence count of all terms, used to rank LIKE-only hits. */
export function termHits(text: string, terms: string[]): number {
  const lower = text.toLowerCase()
  let hits = 0
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (!needle) continue
    for (let index = lower.indexOf(needle); index >= 0; index = lower.indexOf(needle, index + needle.length)) hits += 1
  }
  return hits
}
