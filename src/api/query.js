import { Router } from 'express'
import { queryRAG, queryRAGStream } from '../rag/ragEngine.js'
import { streamAnswer } from '../rag/answerSse.js'
import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'
import { queryLimiter } from '../middleware/rateLimit.js'
import { promptGuardrails } from '../middleware/guardrails.js'
import { retrievalConfig, llmConfig } from '../config.js'
import { recordTurn } from '../services/conversationService.js'

const ist = () => new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })

const router = Router({ mergeParams: true })

router.use(authenticate, requireTenant, queryLimiter, promptGuardrails)

const MAX_QUERY_LENGTH = 2000
const MAX_DOCUMENT_FILTER = 50
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const handleError = (error, res) => {
  console.error('Error processing query:', error)

  if (error.code === 'VECTOR_STORE_NOT_READY') {
    return res.status(503).json({
      success: false,
      error: 'Vector store is not ready. Please try again shortly.'
    })
  }

  if (
    error.code === 'EMBEDDING_NOT_CONFIGURED' ||
    error.code === 'RERANK_NOT_CONFIGURED' ||
    error.code === 'LLM_NOT_CONFIGURED'
  ) {
    return res.status(503).json({
      success: false,
      error: 'The service is missing required API credentials.'
    })
  }

  if (error.provider === 'voyage') {
    return res.status(502).json({
      success: false,
      error: 'The embedding service is unavailable. Please try again shortly.'
    })
  }

  if (error.provider === 'nvidia') {
    return res.status(502).json({
      success: false,
      error: 'The language model is unavailable. Please try again shortly.'
    })
  }

  if (error.name === 'AbortError') {
    return res.status(504).json({
      success: false,
      error: 'The request timed out. Try a shorter or more specific question.'
    })
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error'
  })
}

const parseDocumentIds = (value) => {
  if (value === undefined || value === null) return undefined

  if (!Array.isArray(value)) return { error: '"documentIds" must be an array' }

  const ids = value.filter(
    (id) => typeof id === 'string' && UUID_PATTERN.test(id)
  )

  if (ids.length !== value.length) {
    return { error: '"documentIds" must contain document UUIDs only' }
  }

  if (ids.length > MAX_DOCUMENT_FILTER) {
    return { error: `"documentIds" is limited to ${MAX_DOCUMENT_FILTER} entries` }
  }

  return { ids: ids.length > 0 ? ids : undefined }
}

const parseHistory = (value) => {
  if (!Array.isArray(value)) return undefined

  const turns = value
    .filter(
      (turn) =>
        turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim()
    )
    .slice(-llmConfig.maxHistoryTurns)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim().slice(0, MAX_QUERY_LENGTH)
    }))

  return turns.length > 0 ? turns : undefined
}

const validateRequest = async (req) => {
  const { tenantId } = req.params
  const { query, topK } = req.body

  if (!query || typeof query !== 'string' || !query.trim()) {
    return { error: 'A non-empty "query" string is required', status: 400 }
  }

  if (query.length > MAX_QUERY_LENGTH) {
    return { error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer`, status: 400 }
  }

  const documentFilter = parseDocumentIds(req.body.documentIds)

  if (documentFilter?.error) {
    return { error: documentFilter.error, status: 400 }
  }

  return {
    tenantId,
    query: query.trim(),
    documentIds: documentFilter?.ids,
    history: parseHistory(req.body.history),
    topK: topK && Number.isInteger(topK) && topK > 0 && topK <= retrievalConfig.maxFinalTopK
      ? topK
      : undefined
  }
}

router.post('/', async (req, res) => {
  const startedAt = Date.now()
  console.log(`[TIMING] [${ist()}] 🌐 [API /query] Request received | stream: ${!!req.body?.stream} | query: "${req.body?.query?.slice(0, 80)}"`)

  try {
    const validation = await validateRequest(req)

    if (validation.error) {
      return res.status(validation.status).json({
        success: false,
        error: validation.error
      })
    }

    const { tenantId, query, topK, documentIds, history } = validation
    const options = { topK, documentIds, history }

    if (req.body.stream === true) {
      return streamAnswer({
        res,
        produce: () => queryRAGStream(tenantId, query, options),
        logLabel: `[QUERY API] ${tenantId}`,
        onComplete: ({ answer, refused, result }) => {
          console.log(`[TIMING] [${ist()}] 🌐 [API /query] Stream finished | total request latency: ${Date.now() - startedAt}ms`)
          recordTurn({
            tenantId,
            userId: req.user?.userId,
            channel: 'dashboard',
            query,
            result: {
              ...result,
              answer,
              noResults: refused
            },
            responseTimeMs: Date.now() - startedAt,
            streamMode: true
          }).catch(err => console.warn('[CONVERSATION] stream turn:', err.message))
        }
      })
    }

    const result = await queryRAG(tenantId, query, options)
    const responseTimeMs = Date.now() - startedAt
    console.log(`[TIMING] [${ist()}] 🌐 [API /query] Non-stream finished | total request latency: ${responseTimeMs}ms`)

    console.log(
      `[QUERY API] ${tenantId}: ${result.chunksUsed ?? 0} chunks, ` +
        `stage=${result.retrieval?.stage ?? 'cached'}, ` +
        `${result.cached ? 'cache hit' : `${result.retrieval?.stats?.elapsedMs ?? '?'}ms retrieval`}`
    )

    const turnRecord = await recordTurn({
      tenantId,
      userId: req.user?.userId,
      channel: 'dashboard',
      query,
      result,
      responseTimeMs,
      streamMode: false
    }).catch(err => {
      console.warn('[CONVERSATION] json turn:', err.message)
      return null
    })

    return res.status(200).json({
      success: true,
      ...result,
      conversationId: turnRecord?.conversationId ?? null,
      turnId: turnRecord?.turnId ?? null
    })

  } catch (error) {
    return handleError(error, res)
  }
})


export default router
