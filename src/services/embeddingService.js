import pLimit from 'p-limit'


const OLLAMA_URL = 'http://ollama:11434/api/embeddings' || 'http://host.docker.internal:11434/api/embeddings' 
const EMBEDDING_MODEL = 'nomic-embed-text'
const REQUEST_TIMEOUT_MS = 60000
const MAX_RETRIES = 5
const CONCURRENCY_LIMIT = 3
const BATCH_SIZE = 20
const BATCH_COOLDOWN_MS = 500
const BATCH_FAILURE_COOLDOWN_MS = 2000
const MAX_CHUNK_CHARS = 8000

const RETRYABLE_STATUS_CODES = [ 404, 429, 500, 502, 503, 504 ]

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


const generateEmbeddingRequest = async (text) => {
  const truncatedText = text.length > MAX_CHUNK_CHARS
    ? text.slice(0, MAX_CHUNK_CHARS)
    : text

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
        prompt: truncatedText,
        truncate: true
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

      const isNetworkError = !error.status
      const isRetryableStatus = RETRYABLE_STATUS_CODES.includes(error.status)
      const shouldRetry = isNetworkError || isRetryableStatus

      if (!shouldRetry || attempt === MAX_RETRIES) {
        break
      }

      const backoffMs = 1000 * Math.pow(2, attempt - 1)

      console.warn(
        `Embedding attempt ${attempt} failed (${error.message}). Retrying in ${backoffMs}ms`
      )

      await sleep(backoffMs)
    }
  }

  console.error(
    'Failed to generate embedding:',
    lastError.message,
    lastError.cause || ''
  )

  throw lastError
}


export const generateEmbeddings = async (texts) => {
  const limit = pLimit(CONCURRENCY_LIMIT)
  const allEmbeddings = []
  let failedCount = 0

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    let batchHadFailure = false

    const tasks = batch.map((text, batchIdx) =>
      limit(async () => {
        try {
          return await generateEmbedding(text)
        } catch (error) {
          const globalIdx = i + batchIdx
          console.warn(`[EMBEDDING] Skipping chunk ${globalIdx} (${text.length} chars) - ${error.message}`)
          failedCount++
          batchHadFailure = true
          return null
        }
      })
    )

    const batchResults = await Promise.all(tasks)
    allEmbeddings.push(...batchResults)

    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE)
    console.log(`[EMBEDDING] Batch ${batchNum}/${totalBatches} completed (${allEmbeddings.length}/${texts.length} chunks, ${failedCount} failed)`)

    if (i + BATCH_SIZE < texts.length) {
      if (batchHadFailure) {
        console.log(`[EMBEDDING] Batch had failures, cooling down for ${BATCH_FAILURE_COOLDOWN_MS}ms...`)
        await sleep(BATCH_FAILURE_COOLDOWN_MS)
      } else {
        await sleep(BATCH_COOLDOWN_MS)
      }
    }
  }

  if (failedCount > 0) {
    console.warn(`[EMBEDDING] Completed with ${failedCount}/${texts.length} chunks failed`)
  }

  return allEmbeddings
}