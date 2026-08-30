import { config, rerankConfig } from '../config.js'

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const requireApiKey = () => {
  if (!config.voyageApiKey) {
    const error = new Error('VOYAGE_API_KEY is not configured')
    error.code = 'RERANK_NOT_CONFIGURED'
    throw error
  }

  return config.voyageApiKey
}

const requestRerank = async (query, documents, topN) => {
  const apiKey = requireApiKey()

  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, rerankConfig.requestTimeoutMs)

  try {
    const response = await fetch(rerankConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        query,
        documents,
        model: rerankConfig.model,
        top_k: topN,
        truncation: true
      })
    })

    if (!response.ok) {
      const errorBody = await response.text()

      const error = new Error(
        `Voyage rerank error ${response.status}: ${errorBody.slice(0, 300)}`
      )
      error.status = response.status
      error.provider = 'voyage'

      throw error
    }

    const data = await response.json()

    if (!Array.isArray(data.data)) {
      throw new Error('Voyage rerank returned no data array')
    }

    return data.data.map((entry) => ({
      index: entry.index,
      score: entry.relevance_score
    }))
  } finally {
    clearTimeout(timeout)
  }
}



export const rerankCandidates = async (query, texts, topN) => {
  if (!rerankConfig.enabled || texts.length === 0) return null

  const documents = texts.map((text) =>
    text.length > rerankConfig.maxDocumentChars
      ? text.slice(0, rerankConfig.maxDocumentChars)
      : text
  )

  const limit = Math.min(topN, documents.length)

  let lastError

  for (let attempt = 1; attempt <= rerankConfig.maxRetries; attempt++) {
    try {
      return await requestRerank(query, documents, limit)
    } catch (error) {
      lastError = error

      if (error.code === 'RERANK_NOT_CONFIGURED') break

      const isNetworkError = !error.status
      const shouldRetry =
        isNetworkError || RETRYABLE_STATUS_CODES.includes(error.status)

      if (!shouldRetry || attempt === rerankConfig.maxRetries) break

      await sleep(500 * 2 ** (attempt - 1))
    }
  }

  console.warn(
    `[RERANK] unavailable, falling back to vector ordering: ${lastError?.message}`
  )

  return null
}

export const RERANK_MODEL = rerankConfig.model
