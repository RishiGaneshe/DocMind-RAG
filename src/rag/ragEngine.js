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
    const cached = await cacheGetJson(cacheKey)

    if (cached) return { ...cached, cached: true }
  }

  const { query: searchQuery, rewritten } = await rewriteQuery(userQuery, history)

  const { chunks, stage, stats } = await retrieve(tenantId, searchQuery, {
    finalTopK: topK,
    documentIds: options.documentIds
  })

  if (chunks.length === 0) {
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

  return await generate(tenantId, userQuery, chunks, {
    stage,
    stats,
    history,
    cacheKey,
    searchQuery,
    rewritten
  })
}

const generate = async (
  tenantId,
  userQuery,
  chunks,
  { stage, stats, history, cacheKey, searchQuery, rewritten }
) => {
  const { filenames, contextChunks } = await prepareContext(tenantId, chunks)

  const raw = await generateAnswer(userQuery, contextChunks, { history })

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
  const topK = options.topK ?? retrievalConfig.finalTopK
  const history = options.history

  const { query: searchQuery, rewritten } = await rewriteQuery(userQuery, history)

  const { chunks, stage, stats } = await retrieve(tenantId, searchQuery, {
    finalTopK: topK,
    documentIds: options.documentIds
  })

  if (chunks.length === 0) {
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

  const { filenames, contextChunks } = await prepareContext(tenantId, chunks)

  const { stream, cleanup } = await generateAnswerStream(
    userQuery,
    contextChunks,
    { history }
  )

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
