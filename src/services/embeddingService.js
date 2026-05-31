import pLimit from 'p-limit'

const OLLAMA_URL = 'http://ollama:11434/api/embeddings' || 'http://localhost:11434/api/embeddings'
const EMBEDDING_MODEL = 'nomic-embed-text'
const REQUEST_TIMEOUT_MS = 30000
const MAX_RETRIES = 3
const CONCURRENCY_LIMIT = 5

const RETRYABLE_STATUS_CODES = [ 429, 500, 502, 503, 504 ]

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


const generateEmbeddingRequest = async (text) => {
  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        prompt: text
      })
    })

    if (!response.ok) {
      const error = new Error(
        `Ollama API error: ${response.status}`
      )

      error.status = response.status

      throw error
    }

    const data = await response.json()

    return data.embedding
  } finally {
    clearTimeout(timeout)
  }
}


export const generateEmbedding = async (text) => {
  let lastError

  for (
    let attempt = 1;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      return await generateEmbeddingRequest(text)
    } catch (error) {
      lastError = error

      const shouldRetry =
        RETRYABLE_STATUS_CODES.includes(error.status)

      if (!shouldRetry || attempt === MAX_RETRIES) {
        break
      }

      const backoffMs = 1000 * Math.pow(2, attempt - 1)

      console.warn(
        `Embedding attempt ${attempt} failed. Retrying in ${backoffMs}ms`
      )

      await sleep(backoffMs)
    }
  }

  console.error(
    'Failed to generate embedding:',
    lastError
  )

  throw lastError
}

export const generateEmbeddings = async (texts) => {
  const limit = pLimit(CONCURRENCY_LIMIT)

  const tasks = texts.map(text =>
    limit(() => generateEmbedding(text))
  )

  return Promise.all(tasks)
}