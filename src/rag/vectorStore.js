import { Pinecone } from '@pinecone-database/pinecone'
import { config, embeddingConfig } from '../config.js'

let pc
let index
let ready = false

export const isVectorStoreReady = () => ready

const assertReady = () => {
  if (!index) {
    const error = new Error('Pinecone not initialized')
    error.code = 'VECTOR_STORE_NOT_READY'
    throw error
  }
}

export const initPinecone = async () => {
  pc = new Pinecone({ apiKey: config.pineconeApiKey })

  const indexName = config.pineconeIndexName
  const { indexes = [] } = await pc.listIndexes()

  const existing = indexes.find((idx) => idx.name === indexName)

  if (!existing) {
    console.log(
      `Creating Pinecone index ${indexName} at dimension ${embeddingConfig.dimension}`
    )

    await pc.createIndex({
      name: indexName,
      dimension: embeddingConfig.dimension,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: config.pineconeCloud,
          region: config.pineconeRegion
        }
      },
      waitUntilReady: true
    })
  } else if (existing.dimension !== embeddingConfig.dimension) {
    throw new Error(
      `Pinecone index "${indexName}" has dimension ${existing.dimension} but ` +
        `${embeddingConfig.model} produces ${embeddingConfig.dimension}. ` +
        'Recreate the index or set EMBEDDING_DIMENSION to match.'
    )
  }

  index = pc.Index(indexName)
  ready = true

  console.log(
    `Pinecone ready: ${indexName} (dimension ${embeddingConfig.dimension})`
  )
}

const UPSERT_BATCH_SIZE = 100

export const upsertVectors = async (tenantId, vectors) => {
  assertReady()

  if (vectors.length === 0) return

  const namespace = index.namespace(tenantId)

  for (let i = 0; i < vectors.length; i += UPSERT_BATCH_SIZE) {
    await namespace.upsert({ records: vectors.slice(i, i + UPSERT_BATCH_SIZE) })
  }
}

export const querySimilarity = async (
  tenantId,
  embedding,
  limit = 40,
  { filter, includeMetadata = false } = {}
) => {
  assertReady()

  const response = await index.namespace(tenantId).query({
    vector: embedding,
    topK: limit,
    includeMetadata,
    includeValues: false,
    ...(filter ? { filter } : {})
  })

  return response.matches ?? []
}

export const fetchVectorMetadata = async (tenantId, ids) => {
  assertReady()

  if (ids.length === 0) return {}

  const response = await index.namespace(tenantId).fetch({ ids })

  return response.records ?? {}
}

const DELETE_BATCH_SIZE = 1000

export const deleteVectors = async (tenantId, ids) => {
  assertReady()

  if (ids.length === 0) return

  const namespace = index.namespace(tenantId)

  for (let i = 0; i < ids.length; i += DELETE_BATCH_SIZE) {
    await namespace.deleteMany({ ids: ids.slice(i, i + DELETE_BATCH_SIZE) })
  }
}

export const listVectorIds = async (tenantId, { prefix, paginationToken, limit } = {}) => {
  assertReady()

  const response = await index.namespace(tenantId).listPaginated({
    ...(prefix ? { prefix } : {}),
    ...(paginationToken ? { paginationToken } : {}),
    ...(limit ? { limit } : {})
  })

  return {
    ids: (response.vectors ?? []).map((vector) => vector.id),
    next: response.pagination?.next ?? null
  }
}

export const describeNamespaceStats = async () => {
  assertReady()

  return await index.describeIndexStats()
}
