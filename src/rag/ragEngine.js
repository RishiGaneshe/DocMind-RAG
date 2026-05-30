import { generateEmbedding } from '../services/embeddingService.js'
import { querySimilarity } from './vectorStore.js'
import { generateAnswer, generateAnswerStream } from '../services/llmService.js'

const DEFAULT_TOP_K = 5
const MIN_SIMILARITY_SCORE = 0.5


const retrieveContext = async (tenantId, userQuery, topK) => {
  const queryEmbedding = await generateEmbedding(userQuery)

  const matches = await querySimilarity(tenantId, queryEmbedding, topK)

  const relevantChunks = matches
    .filter(match => match.score >= MIN_SIMILARITY_SCORE)
    .map(match => ({
      text: match.metadata?.text || '',
      score: match.score,
      documentId: match.metadata?.documentId,
      chunkIndex: match.metadata?.chunkIndex
    }))

  return relevantChunks
}


const buildSources = (chunks) => {
  return chunks.map(chunk => ({
    documentId: chunk.documentId,
    chunkIndex: chunk.chunkIndex,
    relevanceScore: chunk.score,
    snippet: chunk.text.substring(0, 200) + (chunk.text.length > 200 ? '...' : '')
  }))
}


export const queryRAG = async (tenantId, userQuery, options = {}) => {
  const { topK = DEFAULT_TOP_K } = options

  const relevantChunks = await retrieveContext(tenantId, userQuery, topK)

  if (relevantChunks.length === 0) {
    return {
      answer: 'I could not find any relevant information in the uploaded documents to answer your question.',
      sources: [],
      query: userQuery
    }
  }

  const contextTexts = relevantChunks.map(chunk => chunk.text)

  const answer = await generateAnswer(userQuery, contextTexts)

  return {
    answer,
    sources: buildSources(relevantChunks),
    query: userQuery,
    chunksUsed: relevantChunks.length
  }
}


export const queryRAGStream = async (tenantId, userQuery, options = {}) => {
  const { topK = DEFAULT_TOP_K } = options

  const relevantChunks = await retrieveContext(tenantId, userQuery, topK)

  if (relevantChunks.length === 0) {
    return {
      stream: null,
      cleanup: () => {},
      sources: [],
      query: userQuery,
      noResults: true
    }
  }

  const contextTexts = relevantChunks.map(chunk => chunk.text)

  const { stream, cleanup } = await generateAnswerStream(userQuery, contextTexts)

  return {
    stream,
    cleanup,
    sources: buildSources(relevantChunks),
    query: userQuery,
    chunksUsed: relevantChunks.length,
    noResults: false
  }
}
