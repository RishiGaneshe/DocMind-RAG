import { Router } from 'express'
import { queryRAG, queryRAGStream } from '../rag/ragEngine.js'
import { streamAnswer } from '../rag/answerSse.js'
import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'
import { queryLimiter } from '../middleware/rateLimit.js'
import { promptGuardrails } from '../middleware/guardrails.js'
import { retrievalConfig, llmConfig } from '../config.js'

const router = Router({ mergeParams: true })

// Ordered deliberately: identity first, then tenant ownership, then the rate
// limiter (which buckets by user id once `req.user` exists), then the content
// guard. Nothing paid happens before all four have passed.
router.use(authenticate, requireTenant, queryLimiter, promptGuardrails)

const MAX_QUERY_LENGTH = 2000
const MAX_DOCUMENT_FILTER = 50
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i


/**
 * Maps upstream failures onto status codes the client can act on. Provider
 * names are matched via the `code`/`provider` fields the services attach, not
 * by substring-matching message text, so renaming a provider cannot silently
 * turn a 502 into a 500.
 */
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


/**
 * Only well-formed UUIDs survive, and at most `MAX_DOCUMENT_FILTER` of them.
 * The list reaches a Pinecone metadata filter and a SQL `IN`, so bounding it
 * here keeps a client from turning a query into an unbounded scan.
 */
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

  // No tenant lookup here. `requireTenant` has already proved that this
  // tenantId is the caller's own, so a row fetch would confirm the existence of
  // a tenant whose id came from a token this server signed.
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
      // The relay lives in `rag/answerSse.js` so the public widget route
      // enforces the identical answer contract rather than its own copy.
      return streamAnswer({
        res,
        produce: () => queryRAGStream(tenantId, query, options),
        logLabel: `[QUERY API] ${tenantId}`
      })
    }

    const result = await queryRAG(tenantId, query, options)

    console.log(
      `[QUERY API] ${tenantId}: ${result.chunksUsed ?? 0} chunks, ` +
        `stage=${result.retrieval?.stage ?? 'cached'}, ` +
        `${result.cached ? 'cache hit' : `${result.retrieval?.stats?.elapsedMs ?? '?'}ms retrieval`}`
    )

    return res.status(200).json({
      success: true,
      ...result
    })

  } catch (error) {
    return handleError(error, res)
  }
})


export default router
