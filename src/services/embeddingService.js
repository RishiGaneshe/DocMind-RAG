const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings"
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY

const EMBEDDING_MODEL = "voyage-4"
const EMBEDDING_DIMENSION = 1024

const REQUEST_TIMEOUT_MS = 60000
const MAX_RETRIES = 5

const BATCH_SIZE = 20
const BATCH_COOLDOWN_MS = 500
const BATCH_FAILURE_COOLDOWN_MS = 2000

const MAX_CHUNK_CHARS = 8000

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504]

if (!VOYAGE_API_KEY) {
  throw new Error("VOYAGE_API_KEY is not configured");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))


const generateEmbeddingBatchRequest = async (texts, inputType = "document") => {
  const preparedTexts = texts.map((text) =>
    text.length > MAX_CHUNK_CHARS ? text.slice(0, MAX_CHUNK_CHARS) : text
  )

  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        input: preparedTexts,
        model: EMBEDDING_MODEL,
        input_type: inputType,
        truncation: true,
        output_dimension: EMBEDDING_DIMENSION,
        output_dtype: "float",
      }),
    })

    if (!response.ok) {
      const errorBody = await response.text()

      const error = new Error(
        `Voyage API error: ${response.status} - ${errorBody}`
      )

      error.status = response.status

      throw error
    }

    const data = await response.json()

    if (!Array.isArray(data.data) || data.data.length !== preparedTexts.length) {
      throw new Error(`Voyage returned ${data.data?.length ?? 0} embeddings for ${preparedTexts.length} texts`
      )
    }

    return data.data.map((item) => {
      if (!Array.isArray(item.embedding)) {
        throw new Error("Voyage API returned an invalid embedding")
      }

      if (item.embedding.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `Unexpected embedding dimension: ${item.embedding.length}`
        )
      }

      return item.embedding
    })
  } finally {
    clearTimeout(timeout)
  }
}

const generateEmbeddingBatch = async (texts, inputType = "document") => {
  let lastError

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await generateEmbeddingBatchRequest(texts, inputType)
    } catch (error) {
      lastError = error

      const isNetworkError = !error.status

      const isRetryableStatus = RETRYABLE_STATUS_CODES.includes(error.status)

      const shouldRetry = isNetworkError || isRetryableStatus

      if (!shouldRetry || attempt === MAX_RETRIES) {
        break;
      }

      const backoffMs = 1000 * Math.pow(2, attempt - 1)

      console.warn(`[EMBEDDING] Batch attempt ${attempt} failed (${error.message}). Retrying in ${backoffMs}ms`)

      await sleep(backoffMs)
    }
  }

  console.error("[EMBEDDING] Batch failed:", lastError?.message)

  throw lastError
}

export const generateEmbedding = async (text, inputType = "query") => {
  if (typeof text !== "string" || !text.trim()) {
    throw new TypeError("text must be a non-empty string");
  }

  const embeddings = await generateEmbeddingBatch([text], inputType)

  if (!embeddings?.[0]) {
    throw new Error("Failed to generate embedding")
  }

  return embeddings[0]
}

export const generateEmbeddings = async (texts, inputType = "document") => {
  if (!Array.isArray(texts)) {
    throw new TypeError("texts must be an array")
  }

  if (texts.length === 0) {
    return []
  }

  const allEmbeddings = []

  const totalBatches = Math.ceil(texts.length / BATCH_SIZE)

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const batchNum = Math.floor(i / BATCH_SIZE) + 1

    try {
      const embeddings = await generateEmbeddingBatch(batch, inputType)

      allEmbeddings.push(...embeddings)

      console.log(`[EMBEDDING] Batch ${batchNum}/${totalBatches} completed (${allEmbeddings.length}/${texts.length})`)

      if (i + BATCH_SIZE < texts.length) {
        await sleep(BATCH_COOLDOWN_MS)
      }
    } catch (error) {
      console.error(`[EMBEDDING] Batch ${batchNum}/${totalBatches} failed:`, error.message)

      allEmbeddings.push(...new Array(batch.length).fill(null))

      if (i + BATCH_SIZE < texts.length) {
        console.log(`[EMBEDDING] Cooling down for ${BATCH_FAILURE_COOLDOWN_MS}ms...`)
        await sleep(BATCH_FAILURE_COOLDOWN_MS)
      }
    }
  }

  const failedCount = allEmbeddings.filter((embedding) => embedding === null).length
  if (failedCount > 0) {
    console.warn(`[EMBEDDING] Completed with ${failedCount}/${texts.length} failed`)
  }

  return allEmbeddings
}
