import { Pinecone } from '@pinecone-database/pinecone'
import { config } from '../config.js'

let pc
let index

export const initPinecone = async () => {
  pc = new Pinecone({
    apiKey: config.pineconeApiKey
  })

  const indexName = config.pineconeIndexName

  const existingIndexes =
    await pc.listIndexes()

  if (
    !existingIndexes.indexes.some(
      idx => idx.name === indexName
    )
  ) {
    console.log(
      `Creating Pinecone index: ${indexName}`
    )

    await pc.createIndex({
      name: indexName,
      dimension: 768,
      metric: 'cosine',
      spec: {
        serverless: {
          cloud: 'aws',
          region: 'us-east-1'
        }
      },
      waitUntilReady: true
    })
  }

  index = pc.Index(indexName)

  console.log(
    'Pinecone initialized successfully'
  )
}

export const upsertVectors = async ( tenantId, vectors ) => {
  if (!index) {
    throw new Error(
      'Pinecone not initialized'
    )
  }

  const namespace =
    index.namespace(tenantId)

  return await namespace.upsert({
    records: vectors
  })
}

export const querySimilarity = async (tenantId, embedding, limit = 5 ) => {
  if (!index) {
    throw new Error( 'Pinecone not initialized' )
  }

  const namespace = index.namespace(tenantId)

  const response = await namespace.query({
      vector: embedding,
      topK: limit,
      includeMetadata: true
  })

  return response.matches
}