import { retrieve } from './retriever.js'
import { rewriteQuery } from './queryRewriter.js'
import {
  generateAnswer,
  generateAnswerStream,
  validateCitations,
  isNoAnswer,
  LLM_MODEL
} from '../services/llmService.js'
import {
  answerCacheKey,
  cacheGetJson,
  cacheSetJson,
  getCorpusVersion
} from '../services/cacheService.js'
import { Document } from '../models/Document.js'
import { retrievalConfig, cacheConfig, NO_ANSWER_MESSAGE } from '../config.js'

const ist = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })

const loadFilenames = async (tenantId, documentIds) => {
  if (documentIds.length === 0) return new Map()

  const documents = await Document.findAll({
    where: { tenantId, id: documentIds },
    attributes: ['id', 'filename'],
    raw: true
  })

  return new Map(documents.map((document) => [document.id, document.filename]))
}

const buildLabel = (chunk, filenames) => {
  if (chunk.breadcrumb) return chunk.breadcrumb

  const filename = filenames.get(chunk.documentId) ?? 'document'
  const page = chunk.pageStart ? ` › page ${chunk.pageStart}` : ''

  return `${filename}${page} › chunk ${chunk.chunkIndex}`
}

const buildSources = (chunks, filenames) =>
  chunks.map((chunk, i) => ({
    citation: i + 1,
    documentId: chunk.documentId,
    filename: filenames.get(chunk.documentId) ?? null,
    chunkIndex: chunk.chunkIndex,
    page: chunk.pageStart ?? null,
    breadcrumb: chunk.breadcrumb ?? null,
    relevanceScore: chunk.rerankScore ?? chunk.cosineScore ?? null,
    scoreType: chunk.rerankScore == null ? 'cosine' : 'rerank',
    snippet: chunk.text.slice(0, 240) + (chunk.text.length > 240 ? '…' : '')
  }))

const prepareContext = async (tenantId, chunks) => {
  const documentIds = [...new Set(chunks.map((chunk) => chunk.documentId))]
  const filenames = await loadFilenames(tenantId, documentIds)

  return {
    filenames,
    contextChunks: chunks.map((chunk) => ({
      text: chunk.text,
      label: buildLabel(chunk, filenames)
    }))
  }
}

export const queryRAG = async (tenantId, userQuery, options = {}) => {
  const pipelineStart = Date.now()
  console.log(`[TIMING] [${ist()}] ========== queryRAG START ========== query: "${userQuery?.slice(0, 80)}"`)

  const topK = options.topK ?? retrievalConfig.finalTopK
  const history = options.history

  const cacheable = cacheConfig.answerEnabled && !history?.length
  const cacheKey = cacheable
    ? answerCacheKey(
        tenantId,
        await getCorpusVersion(tenantId),
        LLM_MODEL,
        userQuery,
        topK
      )
    : null

  if (cacheKey) {
    const answerCacheStart = Date.now()
    const cached = await cacheGetJson(cacheKey)
    console.log(`[TIMING] [${ist()}]   └─ answer cache lookup: ${Date.now() - answerCacheStart}ms (${cached ? 'HIT' : 'MISS'})`)

    if (cached) {
      console.log(`[TIMING] [${ist()}] ========== queryRAG END (cached) ========== ${Date.now() - pipelineStart}ms`)
      return { ...cached, cached: true }
    }
  }

  const rewriteStart = Date.now()
  const { query: searchQuery, rewritten } = await rewriteQuery(userQuery, history)
  console.log(`[TIMING] [${ist()}]   └─ rewriteQuery total: ${Date.now() - rewriteStart}ms | rewritten: ${rewritten} | searchQuery: "${searchQuery?.slice(0, 80)}"`)

  const retrieveStart = Date.now()
  const { chunks, stage, stats } = await retrieve(tenantId, searchQuery, {
    finalTopK: topK,
    documentIds: options.documentIds
  })
  console.log(`[TIMING] [${ist()}]   └─ retrieve total: ${Date.now() - retrieveStart}ms | chunks: ${chunks.length} | stage: ${stage}`)

  if (chunks.length === 0) {
    console.log(`[TIMING] [${ist()}] ========== queryRAG END (no chunks) ========== ${Date.now() - pipelineStart}ms`)
    return {
      answer: NO_ANSWER_MESSAGE,
      sources: [],
      query: userQuery,
      searchQuery,
      rewritten,
      chunksUsed: 0,
      retrieval: { stage, stats }
    }
  }

  const result = await generate(tenantId, userQuery, chunks, {
    stage,
    stats,
    history,
    cacheKey,
    searchQuery,
    rewritten
  })

  console.log(`[TIMING] [${ist()}] ========== queryRAG END ========== ${Date.now() - pipelineStart}ms total`)
  return result
}

const generate = async (
  tenantId,
  userQuery,
  chunks,
  { stage, stats, history, cacheKey, searchQuery, rewritten }
) => {
  const contextStart = Date.now()
  const { filenames, contextChunks } = await prepareContext(tenantId, chunks)
  console.log(`[TIMING] [${ist()}]   └─ prepareContext: ${Date.now() - contextStart}ms`)

  const llmStart = Date.now()
  console.log(`[TIMING] [${ist()}]   └─ generateAnswer LLM call START`)
  const raw = await generateAnswer(userQuery, contextChunks, { history })
  console.log(`[TIMING] [${ist()}]   └─ generateAnswer LLM call END — ${Date.now() - llmStart}ms`)

  if (isNoAnswer(raw)) {
    return {
      answer: NO_ANSWER_MESSAGE,
      sources: [],
      query: userQuery,
      searchQuery,
      rewritten,
      chunksUsed: chunks.length,
      retrieval: { stage, stats }
    }
  }

  const { answer, citedSources, droppedCitations } = validateCitations(
    raw,
    chunks.length
  )

  if (droppedCitations > 0) {
    console.warn(
      `[RAG] dropped ${droppedCitations} citation(s) pointing outside the ` +
        `${chunks.length} supplied sources`
    )
  }

  const result = {
    answer,
    sources: buildSources(chunks, filenames),
    citedSources,
    query: userQuery,
    searchQuery,
    rewritten,
    chunksUsed: chunks.length,
    retrieval: { stage, stats }
  }

  if (cacheKey) {
    await cacheSetJson(cacheKey, result, cacheConfig.answerTtlSeconds)
  }

  return result
}

export const queryRAGStream = async (tenantId, userQuery, options = {}) => {
  const pipelineStart = Date.now()
  console.log(`[TIMING] [${ist()}] ========== queryRAGStream START ========== query: "${userQuery?.slice(0, 80)}"`)

  const topK = options.topK ?? retrievalConfig.finalTopK
  const history = options.history

  const rewriteStart = Date.now()
  const { query: searchQuery, rewritten } = await rewriteQuery(userQuery, history)
  console.log(`[TIMING] [${ist()}]   └─ rewriteQuery total: ${Date.now() - rewriteStart}ms | rewritten: ${rewritten} | searchQuery: "${searchQuery?.slice(0, 80)}"`)

  const retrieveStart = Date.now()
  const { chunks, stage, stats } = await retrieve(tenantId, searchQuery, {
    finalTopK: topK,
    documentIds: options.documentIds
  })
  console.log(`[TIMING] [${ist()}]   └─ retrieve total: ${Date.now() - retrieveStart}ms | chunks: ${chunks.length} | stage: ${stage}`)

  if (chunks.length === 0) {
    console.log(`[TIMING] [${ist()}] ========== queryRAGStream END (no chunks) ========== ${Date.now() - pipelineStart}ms`)
    return {
      stream: null,
      cleanup: () => {},
      sources: [],
      query: userQuery,
      searchQuery,
      rewritten,
      noResults: true,
      retrieval: { stage, stats }
    }
  }

  const contextStart = Date.now()
  const { filenames, contextChunks } = await prepareContext(tenantId, chunks)
  console.log(`[TIMING] [${ist()}]   └─ prepareContext: ${Date.now() - contextStart}ms`)

  const streamStart = Date.now()
  console.log(`[TIMING] [${ist()}]   └─ generateAnswerStream LLM call START`)
  const { stream, cleanup } = await generateAnswerStream(
    userQuery,
    contextChunks,
    { history }
  )
  console.log(`[TIMING] [${ist()}]   └─ generateAnswerStream TTFB — ${Date.now() - streamStart}ms`)
  console.log(`[TIMING] [${ist()}] ========== queryRAGStream END (stream opened) ========== ${Date.now() - pipelineStart}ms pre-stream`)

  return {
    stream,
    cleanup,
    sources: buildSources(chunks, filenames),
    query: userQuery,
    searchQuery,
    rewritten,
    chunksUsed: chunks.length,
    sourceCount: chunks.length,
    noResults: false,
    retrieval: { stage, stats }
  }
}
