import { Router } from 'express'
import { Tenant } from '../models/Tenant.js'
import { queryRAG, queryRAGStream } from '../rag/ragEngine.js'
import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'

const router = Router({ mergeParams: true })

// Apply auth middleware to all routes
router.use(authenticate, requireTenant)

const MAX_QUERY_LENGTH = 2000


const handleError = (error, res) => {
  console.error('Error processing query:', error)

  if (error.message?.includes('Pinecone not initialized')) {
    return res.status(503).json({
      success: false,
      error: 'Vector store is not ready. Please try again shortly.'
    })
  }

  if (error.message?.includes('Ollama')) {
    return res.status(502).json({
      success: false,
      error: 'Embedding service is unavailable. Ensure Ollama is running.'
    })
  }

  if (error.message?.includes('Groq')) {
    return res.status(502).json({
      success: false,
      error: 'LLM service encountered an error. Please try again.'
    })
  }

  return res.status(500).json({
    success: false,
    error: 'Internal server error'
  })
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

  const tenant = await Tenant.findByPk(tenantId)

  if (!tenant) {
    return { error: 'Tenant not found', status: 404 }
  }

  return {
    tenantId,
    query: query.trim(),
    topK: topK && Number.isInteger(topK) && topK > 0 && topK <= 20
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

    const { tenantId, query, topK } = validation
    const stream = req.body.stream === true

    if (stream) {
      return handleStreamResponse(tenantId, query, topK, res)
    }

    const result = await queryRAG(tenantId, query, { topK })

    console.log(`[QUERY API] Query processed successfully for tenant: ${tenantId}`)

    return res.status(200).json({
      success: true,
      ...result
    })

  } catch (error) {
    return handleError(error, res)
  }
})


const handleStreamResponse = async (tenantId, query, topK, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const result = await queryRAGStream(tenantId, query, { topK })

    sendSSE('sources', {
      sources: result.sources,
      query: result.query,
      chunksUsed: result.chunksUsed || 0
    })

    if (result.noResults) {
      sendSSE('chunk', {
        content: 'I could not find any relevant information in the uploaded documents to answer your question.'
      })
      sendSSE('done', { success: true })
      console.log(`[QUERY API] Stream query processed successfully (no results) for tenant: ${tenantId}`)
      return res.end()
    }

    const reader = result.stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const jsonStr = trimmed.slice(6)

          if (jsonStr === '[DONE]') {
            sendSSE('done', { success: true })
            continue
          }

          try {
            const parsed = JSON.parse(jsonStr)
            const content = parsed?.choices?.[0]?.delta?.content

            if (content) {
              sendSSE('chunk', { content })
            }
          } catch {
            // skip malformed chunks
          }
        }
      }
    } finally {
      reader.releaseLock()
      result.cleanup()
    }

    console.log(`[QUERY API] Stream query processed successfully for tenant: ${tenantId}`)
    res.end()

  } catch (error) {
    console.error('Streaming error:', error)
    sendSSE('error', {
      error: 'An error occurred while generating the answer.'
    })
    res.end()
  }
}

export default router
