/** Vector math and rank fusion for hybrid (keyword + embedding) retrieval. */

export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (!leftNorm || !rightNorm) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export interface RankedList<T extends string | number> {
  ids: T[]
  weight?: number
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ weight / (k + rank). Robust to the very
 * different score scales of BM25 and cosine similarity.
 */
export function reciprocalRankFusion<T extends string | number>(lists: Array<RankedList<T>>, k = 60): Array<{ id: T; score: number; sources: number[] }> {
  const scores = new Map<T, { score: number; sources: number[] }>()
  lists.forEach((list, listIndex) => {
    const weight = list.weight ?? 1
    list.ids.forEach((id, rank) => {
      const entry = scores.get(id) ?? { score: 0, sources: [] }
      entry.score += weight / (k + rank + 1)
      entry.sources.push(listIndex)
      scores.set(id, entry)
    })
  })
  return [...scores.entries()]
    .map(([id, entry]) => ({ id, ...entry }))
    .sort((left, right) => right.score - left.score)
}

/** Top-k by score without sorting the whole array. */
export function topK<T>(items: Iterable<T>, k: number, score: (item: T) => number): Array<{ item: T; score: number }> {
  const best: Array<{ item: T; score: number }> = []
  for (const item of items) {
    const value = score(item)
    if (best.length < k) {
      best.push({ item, score: value })
      best.sort((a, b) => b.score - a.score)
    } else if (value > best[best.length - 1]!.score) {
      best[best.length - 1] = { item, score: value }
      best.sort((a, b) => b.score - a.score)
    }
  }
  return best
}
