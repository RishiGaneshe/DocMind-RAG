import { generateEmbedding } from '../services/embeddingService.js'
import { rerankCandidates, RERANK_MODEL } from '../services/rerankService.js'
import {
  cacheGetJson,
  cacheSetJson,
  rerankCacheKey
} from '../services/cacheService.js'
import { retrievalConfig, cacheConfig } from '../config.js'
import { querySimilarity, fetchVectorMetadata } from './vectorStore.js'
import { hydrateChunks, lexicalSearch } from './chunkStore.js'
import { fuseRankings, suppressDuplicates } from './ranking.js'

const denseLane = async (tenantId, queryEmbedding, documentIds) => {
  const filter =
    Array.isArray(documentIds) && documentIds.length > 0
      ? { documentId: { $in: documentIds } }
      : undefined

  const matches = await querySimilarity(
    tenantId,
    queryEmbedding,
    retrievalConfig.candidateTopK,
    { filter }
  )

  return matches
    .filter((match) => match.score >= retrievalConfig.minCosineScore)
    .map((match) => ({ id: match.id, score: match.score }))
}

const lexicalLane = async (tenantId, query, documentIds) => {
  if (!retrievalConfig.hybridEnabled) return []

  try {
    return await lexicalSearch(tenantId, query, retrievalConfig.candidateTopK, {
      documentIds
    })
  } catch (error) {
    console.warn(
      `[RETRIEVAL] lexical lane failed, continuing dense-only: ${error.message}`
    )

    return []
  }
}

const hydrate = async (tenantId, ids) => {
  const fromPostgres = await hydrateChunks(tenantId, ids)
  const missing = ids.filter((id) => !fromPostgres.has(id))

  let fromPinecone = {}

  if (missing.length > 0) {
    fromPinecone = await fetchVectorMetadata(tenantId, missing)

    console.log(
      `[RETRIEVAL] ${missing.length}/${ids.length} candidates hydrated from ` +
        'Pinecone metadata (chunk store not backfilled for these)'
    )
  }

  const chunks = new Map()

  for (const id of ids) {
    const row = fromPostgres.get(id)

    if (row) {
      chunks.set(id, {
        id,
        text: row.text,
        documentId: row.documentId,
        chunkIndex: row.chunkIndex,
        breadcrumb: row.breadcrumb,
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        chunkingVersion: row.chunkingVersion
      })

      continue
    }

    const metadata = fromPinecone[id]?.metadata

    if (!metadata?.text) continue

    chunks.set(id, {
      id,
      text: metadata.text,
      documentId: metadata.documentId,
      chunkIndex: metadata.chunkIndex,
      breadcrumb: null,
      pageStart: null,
      pageEnd: null,
      chunkingVersion: 1
    })
  }

  return chunks
}

const rerankWithCache = async (query, candidates) => {
  const key = rerankCacheKey(
    RERANK_MODEL,
    query,
    candidates.map((candidate) => candidate.id)
  )

  if (cacheConfig.rerankEnabled) {
    const cached = await cacheGetJson(key)

    if (Array.isArray(cached)) return cached
  }

  const ranked = await rerankCandidates(
    query,
    candidates.map((candidate) => candidate.text),
    candidates.length
  )

  if (ranked && cacheConfig.rerankEnabled) {
    await cacheSetJson(key, ranked, cacheConfig.rerankTtlSeconds)
  }

  return ranked
}

const selectFinalists = (ranked, deduped, finalTopK) => {
  if (ranked) {
    const best = ranked[0]?.score ?? 0
    const floor = Math.max(
      retrievalConfig.minRerankScore,
      best * retrievalConfig.relativeScoreFloor
    )

    return ranked
      .filter((entry) => entry.score >= floor)
      .slice(0, finalTopK)
      .map((entry) => ({ ...deduped[entry.index], rerankScore: entry.score }))
  }

  const bestCosine = deduped.reduce(
    (max, c) => (c.cosineScore !== null && c.cosineScore > max ? c.cosineScore : max),
    0
  )
  const cosineFloor = Math.max(
    retrievalConfig.minCosineScore,
    bestCosine * retrievalConfig.relativeScoreFloor
  )

  return deduped
    .filter(
      (candidate) =>
        candidate.cosineScore === null || candidate.cosineScore >= cosineFloor
    )
    .slice(0, finalTopK)
    .map((candidate) => ({ ...candidate, rerankScore: null }))
}

export const retrieve = async (tenantId, query, options = {}) => {
  const finalTopK = options.finalTopK ?? retrievalConfig.finalTopK
  const { documentIds } = options

  const startedAt = Date.now()

  const [dense, lexical] = await Promise.all([
    generateEmbedding(query, 'query').then((emb) =>
      denseLane(tenantId, emb, documentIds)
    ),
    lexicalLane(tenantId, query, documentIds)
  ])

  if (dense.length === 0 && lexical.length === 0) {
    return { chunks: [], stage: 'no-candidates', timings: {} }
  }

  const cosineScores = new Map(dense.map((entry) => [entry.id, entry.score]))

  const fused = fuseRankings(
    [dense.map((entry) => entry.id), lexical.map((entry) => entry.id)].filter(
      (ranking) => ranking.length > 0
    ),
    retrievalConfig.rrfK
  ).slice(0, retrievalConfig.candidateTopK)

  const hydrated = await hydrate(
    tenantId,
    fused.map((entry) => entry.id)
  )

  const candidates = fused
    .map((entry) => {
      const chunk = hydrated.get(entry.id)

      if (!chunk || !chunk.text?.trim()) return null

      return {
        ...chunk,
        fusedScore: entry.fusedScore,
        cosineScore: cosineScores.get(entry.id) ?? null
      }
    })
    .filter(Boolean)

  if (candidates.length === 0) {
    return { chunks: [], stage: 'unhydrated', timings: {} }
  }

  const deduped = suppressDuplicates(
    candidates,
    retrievalConfig.duplicateThreshold
  )

  const ranked = await rerankWithCache(query, deduped)

  const chunks = selectFinalists(ranked, deduped, finalTopK)

  return {
    chunks,
    stage: ranked ? 'reranked' : 'fused',
    stats: {
      dense: dense.length,
      lexical: lexical.length,
      fused: fused.length,
      hydrated: candidates.length,
      deduped: deduped.length,
      final: chunks.length,
      elapsedMs: Date.now() - startedAt
    }
  }
}
