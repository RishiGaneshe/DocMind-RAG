import pLimit from 'p-limit'
import { config, embeddingConfig, cacheConfig } from '../config.js'
import {
  cacheGetManyJson,
  cacheSetManyJson,
  embeddingCacheKey
} from './cacheService.js'

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Resolved per call rather than at import. A missing key previously threw
 * while the module was still loading, which took the whole process down
 * instead of failing the one request that needed it.
 */
const requireApiKey = () => {
  if (!config.voyageApiKey) {
    const error = new Error('VOYAGE_API_KEY is not configured')
    error.code = 'EMBEDDING_NOT_CONFIGURED'
    throw error
  }

  return config.voyageApiKey
}

/**
 * An oversized input is a chunking defect, so it is surfaced rather than
 * quietly truncated. Truncating here used to leave the stored chunk text
 * different from the text that was actually embedded.
 */
const assertWithinLimit = (texts) => {
  const offender = texts.findIndex(
    (text) => text.length > embeddingConfig.maxInputChars
  )

  if (offender === -1) return

  const error = new Error(
    `Embedding input ${offender} is ${texts[offender].length} characters, ` +
      `over the ${embeddingConfig.maxInputChars} limit. Split it upstream.`
  )
  error.code = 'EMBEDDING_INPUT_TOO_LARGE'

  throw error
}

const requestBatch = async (texts, inputType) => {
  const apiKey = requireApiKey()

  assertWithinLimit(texts)

  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, embeddingConfig.requestTimeoutMs)

  try {
    const response = await fetch(embeddingConfig.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        input: texts,
        model: embeddingConfig.model,
        input_type: inputType,
        truncation: true,
        output_dimension: embeddingConfig.dimension,
        output_dtype: 'float'
      })
    })

    if (!response.ok) {
      const errorBody = await response.text()

      const error = new Error(
        `Voyage embedding error ${response.status}: ${errorBody.slice(0, 300)}`
      )
      error.status = response.status
      error.provider = 'voyage'

      throw error
    }

    const data = await response.json()

    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error(
        `Voyage returned ${data.data?.length ?? 0} embeddings for ${texts.length} inputs`
      )
    }

    return data.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => {
        if (
          !Array.isArray(item.embedding) ||
          item.embedding.length !== embeddingConfig.dimension
        ) {
          throw new Error(
            `Voyage returned an embedding of dimension ${item.embedding?.length} ` +
              `(expected ${embeddingConfig.dimension})`
          )
        }

        return item.embedding
      })
  } finally {
    clearTimeout(timeout)
  }
}

const requestBatchWithRetry = async (texts, inputType) => {
  let lastError

  for (let attempt = 1; attempt <= embeddingConfig.maxRetries; attempt++) {
    try {
      return await requestBatch(texts, inputType)
    } catch (error) {
      lastError = error

      // A missing key or an oversized input will never succeed on retry.
      if (
        error.code === 'EMBEDDING_NOT_CONFIGURED' ||
        error.code === 'EMBEDDING_INPUT_TOO_LARGE'
      ) {
        throw error
      }

      const isNetworkError = !error.status
      const shouldRetry =
        isNetworkError || RETRYABLE_STATUS_CODES.includes(error.status)

      if (!shouldRetry || attempt === embeddingConfig.maxRetries) break

      const backoffMs = 1000 * 2 ** (attempt - 1)

      console.warn(
        `[EMBEDDING] attempt ${attempt} failed (${error.message}). ` +
          `Retrying in ${backoffMs}ms`
      )

      await sleep(backoffMs)
    }
  }

  throw lastError
}

const chunkArray = (items, size) => {
  const batches = []

  for (let i = 0; i < items.length; i += size) {
    batches.push({ offset: i, items: items.slice(i, i + size) })
  }

  return batches
}

/**
 * Embeds an array of texts, preserving input order. Entries that fail after
 * exhausting retries come back as null so a partially embedded document can
 * still be stored; callers decide whether that is acceptable.
 *
 * Batches run concurrently under a limiter rather than sequentially with a
 * fixed cooldown, which is what made large uploads take minutes.
 */
export const generateEmbeddings = async (texts, inputType = 'document') => {
  if (!Array.isArray(texts)) {
    throw new TypeError('texts must be an array')
  }

  if (texts.length === 0) return []

  const results = new Array(texts.length).fill(null)
  const cacheEnabled = cacheConfig.embeddingEnabled

  const keys = texts.map((text) =>
    embeddingCacheKey(
      embeddingConfig.model,
      embeddingConfig.dimension,
      inputType,
      text
    )
  )

  if (cacheEnabled) {
    const cached = await cacheGetManyJson(keys)

    cached.forEach((embedding, i) => {
      if (Array.isArray(embedding) && embedding.length === embeddingConfig.dimension) {
        results[i] = embedding
      }
    })
  }

  const pending = texts
    .map((text, index) => ({ text, index }))
    .filter((item) => results[item.index] === null)

  if (pending.length === 0) {
    console.log(`[EMBEDDING] ${texts.length}/${texts.length} served from cache`)
    return results
  }

  const batches = chunkArray(pending, embeddingConfig.batchSize)
  const limit = pLimit(embeddingConfig.concurrency)
  const freshEntries = []

  let completed = 0

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        try {
          const embeddings = await requestBatchWithRetry(
            batch.items.map((item) => item.text),
            inputType
          )

          batch.items.forEach((item, i) => {
            results[item.index] = embeddings[i]
            freshEntries.push([keys[item.index], embeddings[i]])
          })
        } catch (error) {
          console.error(
            `[EMBEDDING] batch at offset ${batch.offset} failed: ${error.message}`
          )
        } finally {
          completed += 1
          console.log(`[EMBEDDING] batch ${completed}/${batches.length} done`)
        }
      })
    )
  )

  if (cacheEnabled && freshEntries.length > 0) {
    await cacheSetManyJson(freshEntries, cacheConfig.embeddingTtlSeconds)
  }

  const failed = results.filter((embedding) => embedding === null).length

  if (failed > 0) {
    console.warn(`[EMBEDDING] ${failed}/${texts.length} inputs failed`)
  }

  return results
}

export const generateEmbedding = async (text, inputType = 'query') => {
  if (typeof text !== 'string' || !text.trim()) {
    throw new TypeError('text must be a non-empty string')
  }

  const [embedding] = await generateEmbeddings([text], inputType)

  if (!embedding) {
    throw new Error('Failed to generate embedding')
  }

  return embedding
}

export const EMBEDDING_MODEL = embeddingConfig.model
export const EMBEDDING_DIMENSION = embeddingConfig.dimension

