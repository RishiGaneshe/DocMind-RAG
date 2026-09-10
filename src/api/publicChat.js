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

const router = Router()

router.use(
  cors({
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
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

router.use(express.json({ limit: publicApiConfig.bodyLimit }))

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_SESSION_ID = 64
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_DOCUMENT_FILTER = 20

const bad = (res, error, code) =>
  res.status(400).json({ success: false, error, code })

const loadTenant = async (tenantId) =>
  await Tenant.findByPk(tenantId, {
    attributes: ['id', 'name', 'widgetConfig']
  })

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
    sessionId: parseSessionId(req.body.sessionId),
    options: {
      topK: parseTopK(req.body.topK),
      history: parseHistory(req.body.history),
      documentIds: req.apiKey.scopes.includes('chat:filter')
        ? parseDocumentIds(req.body.documentIds)
        : undefined
    }
  }
}

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

