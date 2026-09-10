import express, { Router } from 'express'
import cors from 'cors'

import { Tenant } from '../models/Tenant.js'
import { queryRAG, queryRAGStream } from '../rag/ragEngine.js'
import { streamAnswer } from '../rag/answerSse.js'
import {
  apiKeyAuth,
  requireScope,
  enforceQuota
} from '../middleware/apiKeyAuth.js'
import { originGuard } from '../middleware/originGuard.js'
import { promptGuardrails } from '../middleware/guardrails.js'
import { resolveWidgetConfig, redactSources } from '../services/widgetService.js'
import { recordTurn } from '../services/conversationService.js'
import { publicApiConfig, retrievalConfig } from '../config.js'

/**
 * The public, unauthenticated chat surface. This is the only router an anonymous
 * visitor's browser ever talks to.
 *
 * Everything here is written on the assumption that the caller is hostile and
 * holds a key they lifted out of a page. The key therefore buys a workspace
 * identity and nothing else: no tenant id is accepted from the request, the
 * retrieval knobs are clamped to public ceilings regardless of what was sent,
 * and the source list is redacted on the way out.
 *
 * It carries its own CORS and body parser rather than inheriting the app's. The
 * app's CORS is an allowlist of the dashboard's own origins, which is the
 * opposite of what is needed here — a widget is embedded on customer sites whose
 * origins this server cannot enumerate in advance. Per-key origin enforcement
 * happens in `originGuard`, after the key is resolved, which a CORS preflight
 * cannot do because `OPTIONS` carries no custom headers.
 */

const router = Router()

router.use(
  cors({
    // Reflects whatever origin asked. The check that matters is `originGuard`,
    // which knows which origins this particular key is allowed on; a browser
    // rejecting the response is not a security boundary we can rely on anyway.
    origin: true,
    // No cookies, ever. A widget on a third-party page must not be able to make
    // the visitor's browser attach credentials to this API.
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
    // Without this the widget's JS cannot read its own rate-limit state and has
    // no way to back off other than guessing.
    exposedHeaders: [
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
      'X-Quota-Limit',
      'X-Quota-Remaining'
    ],
    maxAge: 86400
  })
)

// Far smaller than the app's 1mb. Nothing legitimate on this route is bigger
// than a question and a few turns of history, and the parse happens before the
// key is known — so it is the one cost an unauthenticated caller can impose.
router.use(express.json({ limit: publicApiConfig.bodyLimit }))

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_SESSION_ID = 64

// A session id is an opaque client-generated token — a uuid or a nanoid in
// practice. Restricting the alphabet matters because this value is the one piece
// of caller-controlled text that reaches the log line: a newline in it would let
// a visitor forge log entries.
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const MAX_DOCUMENT_FILTER = 20

const bad = (res, error, code) =>
  res.status(400).json({ success: false, error, code })

/**
 * Loads the workspace behind the resolved key.
 *
 * A cached key record can briefly outlive its tenant, so a missing row is a real
 * possibility rather than an impossibility worth ignoring.
 */
const loadTenant = async (tenantId) =>
  await Tenant.findByPk(tenantId, {
    attributes: ['id', 'name', 'widgetConfig']
  })

/**
 * Maps failures onto codes the widget can act on, without naming which upstream
 * provider broke. A visitor cannot do anything with "Voyage is down", and the
 * name of the embedding vendor is not something the workspace owner has agreed
 * to publish on their site.
 */
const handlePublicError = (error, res, keyPrefix) => {
  console.error(`[PUBLIC CHAT] ${keyPrefix}: ${error.code ?? error.name}: ${error.message}`)

  if (
    error.code === 'VECTOR_STORE_NOT_READY' ||
    error.code === 'EMBEDDING_NOT_CONFIGURED' ||
    error.code === 'RERANK_NOT_CONFIGURED' ||
    error.code === 'LLM_NOT_CONFIGURED' ||
    error.provider
  ) {
    return res.status(503).json({
      success: false,
      error: 'The assistant is temporarily unavailable. Please try again shortly.',
      code: 'SERVICE_UNAVAILABLE'
    })
  }

  if (error.name === 'AbortError') {
    return res.status(504).json({
      success: false,
      error: 'That took too long. Try a shorter or more specific question.',
      code: 'TIMEOUT'
    })
  }

  return res.status(500).json({
    success: false,
    error: 'Something went wrong answering that question.',
    code: 'INTERNAL_ERROR'
  })
}

/**
 * Trims client-sent history to something bounded.
 *
 * The widget holds the conversation, not the server, so this array is entirely
 * attacker-controlled: it is the cheapest way to inflate the prompt this route
 * pays for. Capping the turn count alone is not enough — six turns of 100 kB
 * each still costs a fortune — so the total character budget is enforced as
 * well, oldest turns dropped first, and each turn is individually truncated.
 */
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
    .slice(-publicApiConfig.maxHistoryTurns)
    .map((turn) => ({
      role: turn.role,
      content: turn.content.trim().slice(0, publicApiConfig.maxQueryLength)
    }))

  let total = turns.reduce((sum, turn) => sum + turn.content.length, 0)

  while (turns.length > 0 && total > publicApiConfig.maxHistoryChars) {
    total -= turns.shift().content.length
  }

  return turns.length > 0 ? turns : undefined
}

/**
 * Clamps rather than rejects. A widget sending `topK: 50` is far more likely to
 * be an over-eager integrator than an attacker, and silently serving them 6 good
 * sources is friendlier than a 400 they have to debug from a customer's site.
 */
const parseTopK = (value) => {
  if (!Number.isInteger(value) || value < 1) return undefined

  return Math.min(value, publicApiConfig.maxTopK, retrievalConfig.maxFinalTopK)
}

const parseDocumentIds = (value) => {
  if (!Array.isArray(value)) return undefined

  const ids = value
    .filter((id) => typeof id === 'string' && UUID_PATTERN.test(id))
    .slice(0, MAX_DOCUMENT_FILTER)

  return ids.length > 0 ? ids : undefined
}

/**
 * Everything the widget needs to render itself before the first message.
 *
 * Deliberately cheap and quota-light: it is hit once per page load, including on
 * pages nobody ever chats on, so it consumes a rate-limit slot but not a message
 * from the daily quota.
 */
router.get(
  '/config',
  apiKeyAuth,
  originGuard,
  requireScope('chat:config'),
  enforceQuota({}),
  async (req, res) => {
    try {
      const tenant = await loadTenant(req.tenantId)

      if (!tenant) {
        return res.status(404).json({
          success: false,
          error: 'This workspace is no longer available.',
          code: 'WORKSPACE_UNAVAILABLE'
        })
      }

      const widget = resolveWidgetConfig(tenant.widgetConfig)

      return res.status(200).json({
        success: true,
        workspace: { name: tenant.name },
        widget,
        limits: {
          maxQueryLength: publicApiConfig.maxQueryLength,
          maxHistoryTurns: publicApiConfig.maxHistoryTurns
        },
        // So the widget can tell "this key cannot filter" from "the filter
        // silently did nothing", which is otherwise indistinguishable.
        capabilities: {
          filterByDocument: req.apiKey.scopes.includes('chat:filter')
        }
      })
    } catch (error) {
      return handlePublicError(error, res, req.apiKey.keyPrefix)
    }
  }
)

const parseSessionId = (value) => {
  if (typeof value !== 'string') return null

  const trimmed = value.trim().slice(0, MAX_SESSION_ID)

  return SESSION_ID_PATTERN.test(trimmed) ? trimmed : null
}

const validateChat = (req) => {
  const query = req.body?.query

  if (!query || typeof query !== 'string' || !query.trim()) {
    return {
      error: 'A non-empty "query" string is required.',
      code: 'QUERY_REQUIRED'
    }
  }

  const trimmed = query.trim()

  if (trimmed.length > publicApiConfig.maxQueryLength) {
    return {
      error: `A question must be ${publicApiConfig.maxQueryLength} characters or fewer.`,
      code: 'QUERY_TOO_LONG'
    }
  }

  return {
    query: trimmed,
    stream: req.body.stream === true,
    // Analytics only, and dropped entirely if it is not a plain token. It is
    // never a rate-limit bucket: an attacker rotates a client-generated id for
    // free, so bucketing on it would be a limiter that asks permission to be
    // bypassed.
    sessionId: parseSessionId(req.body.sessionId),
    options: {
      topK: parseTopK(req.body.topK),
      history: parseHistory(req.body.history),
      // Filtering is a property of the key, not of the request. A widget key
      // without `chat:filter` cannot aim retrieval at chosen documents, so a
      // lifted key cannot be used to probe the corpus document by document.
      documentIds: req.apiKey.scopes.includes('chat:filter')
        ? parseDocumentIds(req.body.documentIds)
        : undefined
    }
  }
}

/**
 * One message.
 *
 * The middleware order is the whole security story, and it is deliberate:
 * identify the workspace, prove the request came from a site the owner listed,
 * prove the key is allowed to ask questions, spend the quota, and only then let
 * the content guard look at the words. Quota is spent before the guardrail
 * check on purpose — a limiter that refunds rejected requests rewards hammering
 * it, and the guardrail is the cheapest thing in the chain to hammer.
 */
router.post(
  '/chat',
  apiKeyAuth,
  originGuard,
  requireScope('chat:query'),
  enforceQuota({ daily: true, visitor: true }),
  promptGuardrails,
  async (req, res) => {
    const { keyPrefix, id: apiKeyId } = req.apiKey
    const startedAt = Date.now()

    try {
      const parsed = validateChat(req)

      if (parsed.error) return bad(res, parsed.error, parsed.code)

      const tenant = await loadTenant(req.tenantId)

      if (!tenant) {
        return res.status(404).json({
          success: false,
          error: 'This workspace is no longer available.',
          code: 'WORKSPACE_UNAVAILABLE'
        })
      }

      const { sourceMode } = resolveWidgetConfig(tenant.widgetConfig)

      const label =
        `[PUBLIC CHAT] ${keyPrefix}` +
        `${parsed.sessionId ? ` session=${parsed.sessionId}` : ''}`

      if (parsed.stream) {
        return streamAnswer({
          res,
          produce: () => queryRAGStream(req.tenantId, parsed.query, parsed.options),
          logLabel: label,
          // The dashboard's event also carries `searchQuery` and `rewritten`.
          // Those are the internal reformulation of the question and belong to
          // the workspace, not to a visitor on someone else's website.
          buildSourcesEvent: (result) => ({
            sources: redactSources(result.sources, sourceMode),
            chunksUsed: result.chunksUsed || 0
          }),
          onComplete: ({ answer, refused, result }) => {
            recordTurn({
              tenantId: req.tenantId,
              apiKeyId,
              channel: 'widget',
              sessionId: parsed.sessionId,
              query: parsed.query,
              result: {
                ...result,
                answer,
                noResults: refused
              },
              responseTimeMs: Date.now() - startedAt,
              streamMode: true
            }).catch(err => console.warn('[CONVERSATION] widget stream turn:', err.message))
          }
        })
      }

      const result = await queryRAG(req.tenantId, parsed.query, parsed.options)
      const responseTimeMs = Date.now() - startedAt

      console.log(
        `${label}: ${result.chunksUsed ?? 0} chunks, ` +
          `${result.cached ? 'cache hit' : `stage=${result.retrieval?.stage ?? '?'}`}`
      )

      // Record fire-and-forget. The public response shape is NOT changed.
      recordTurn({
        tenantId: req.tenantId,
        apiKeyId,
        channel: 'widget',
        sessionId: parsed.sessionId,
        query: parsed.query,
        result,
        responseTimeMs,
        streamMode: false
      }).catch(err => console.warn('[CONVERSATION] widget json turn:', err.message))

      return res.status(200).json({
        success: true,
        answer: result.answer,
        sources: redactSources(result.sources, sourceMode),
        citedSources: result.citedSources ?? [],
        chunksUsed: result.chunksUsed ?? 0
      })
    } catch (error) {
      return handlePublicError(error, res, keyPrefix)
    }
  }
)

export default router

