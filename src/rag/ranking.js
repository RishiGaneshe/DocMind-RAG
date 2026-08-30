/**
 * Pure ranking helpers, deliberately free of any I/O or configuration import so
 * they can be unit tested without a database, a Redis, or an API key.
 */

/**
 * Reciprocal Rank Fusion. Dense cosine similarity and lexical `ts_rank_cd` live
 * on incomparable scales, so the lanes are fused on rank position rather than
 * on score. `k` damps the influence of the very top positions, which is what
 * stops one confident lane from crowding the other out entirely.
 */
export const fuseRankings = (rankings, k) => {
  const scores = new Map()

  for (const ranking of rankings) {
    ranking.forEach((id, position) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + position + 1))
    })
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, fusedScore]) => ({ id, fusedScore }))
}

export const trigrams = (text) => {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const grams = new Set()

  for (let i = 0; i + 3 <= normalized.length; i++) {
    grams.add(normalized.slice(i, i + 3))
  }

  return grams
}

export const jaccard = (a, b) => {
  if (a.size === 0 || b.size === 0) return 0

  const [small, large] = a.size <= b.size ? [a, b] : [b, a]

  let intersection = 0

  for (const gram of small) {
    if (large.has(gram)) intersection += 1
  }

  return intersection / (a.size + b.size - intersection)
}

/**
 * Drops candidates that substantially repeat one already kept. Chunks overlap
 * by design, so adjacent chunks share text and the final context was spending
 * several of its few slots on the same paragraph.
 */
export const suppressDuplicates = (candidates, threshold) => {
  const kept = []
  const keptGrams = []

  for (const candidate of candidates) {
    const grams = trigrams(candidate.text)

    if (keptGrams.some((existing) => jaccard(existing, grams) >= threshold)) {
      continue
    }

    kept.push(candidate)
    keptGrams.push(grams)
  }

  return kept
}
