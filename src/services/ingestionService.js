import pLimit from 'p-limit'

import { processDocument } from './documentService.js'
import { generateEmbeddings } from './embeddingService.js'
import { bumpCorpusVersion } from './cacheService.js'
import { Document } from '../models/Document.js'
import { upsertVectors, deleteVectors } from '../rag/vectorStore.js'
import { saveChunks, deleteChunksForDocument, buildChunkId } from '../rag/chunkStore.js'
import { CHUNKING_VERSION } from '../rag/chunker.js'
import { uploadConfig } from '../config.js'

const limit = pLimit(uploadConfig.maxConcurrentJobs)

const MAX_QUEUE_DEPTH = Math.max(4, uploadConfig.maxConcurrentJobs * 8)

export const ingestionLoad = () => ({
  active: limit.activeCount,
  queued: limit.pendingCount,
  capacity: MAX_QUEUE_DEPTH
})

export const ingestionSaturated = () => limit.pendingCount >= MAX_QUEUE_DEPTH

const EMPTY_TEXT_MESSAGE =
  'No extractable text found in document. Scanned PDFs need OCR before upload.'

const runIngestion = async (documentId, tenantId, filename, fileBuffer) => {
  let vectorIds = []

  try {
    await Document.update(
      { status: 'PROCESSING', processingStartedAt: new Date() },
      { where: { id: documentId, tenantId } }
    )

    const { chunks, numPages } = await processDocument(fileBuffer, filename)

    if (chunks.length === 0) {
      throw Object.assign(new Error(EMPTY_TEXT_MESSAGE), { code: 'NO_TEXT' })
    }

    const embeddings = await generateEmbeddings(
      chunks.map((chunk) => chunk.text),
      'document'
    )

    const embedded = chunks
      .map((chunk, index) => ({ chunk, embedding: embeddings[index] }))
      .filter((entry) => entry.embedding !== null)

    const skipped = chunks.length - embedded.length

    if (skipped > 0) {
      console.warn(
        `[INGEST] ${documentId}: ${skipped}/${chunks.length} chunks failed ` +
          'embedding and were skipped'
      )
    }

    if (embedded.length === 0) {
      throw new Error('All chunks failed to embed — document cannot be stored')
    }

    const vectors = embedded.map(({ chunk, embedding }) => ({
      id: buildChunkId(documentId, chunk.chunkIndex),
      values: embedding,
      metadata: {
        tenantId,
        documentId,
        chunkIndex: chunk.chunkIndex,
        chunkingVersion: CHUNKING_VERSION,
        pageStart: chunk.pageStart ?? 0,
        pageEnd: chunk.pageEnd ?? 0,
        text: chunk.text
      }
    }))

    vectorIds = vectors.map((vector) => vector.id)

    await upsertVectors(tenantId, vectors)

    await saveChunks(
      embedded.map(({ chunk }) => ({
        id: buildChunkId(documentId, chunk.chunkIndex),
        tenantId,
        documentId,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        charCount: chunk.charCount,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        heading: chunk.heading,
        breadcrumb: chunk.breadcrumb,
        chunkingVersion: CHUNKING_VERSION
      }))
    )

    await Document.update(
      {
        status: 'COMPLETED',
        totalChunks: embedded.length,
        numPages,
        processingCompletedAt: new Date(),
        failureReason: null
      },
      { where: { id: documentId, tenantId } }
    )

    await bumpCorpusVersion(tenantId)

    console.log(
      `[INGEST] ${documentId}: stored ${embedded.length} chunks from ` +
        `${filename} (${numPages} pages, tenant ${tenantId})`
    )
  } catch (error) {
    console.error(`[INGEST] ${documentId} failed: ${error.message}`)

    if (vectorIds.length > 0) {
      await deleteVectors(tenantId, vectorIds).catch((cleanupError) => {
        console.error(
          `[INGEST] vector cleanup failed for ${documentId}: ${cleanupError.message}`
        )
      })
    }

    await deleteChunksForDocument(tenantId, documentId).catch((cleanupError) => {
      console.error(
        `[INGEST] chunk cleanup failed for ${documentId}: ${cleanupError.message}`
      )
    })

    await Document.update(
      {
        status: 'FAILED',
        totalChunks: 0,
        failureReason: error.message?.slice(0, 1000) ?? 'Unknown error',
        processingCompletedAt: new Date()
      },
      { where: { id: documentId, tenantId } }
    ).catch((updateError) => {
      console.error(
        `[INGEST] could not mark ${documentId} FAILED: ${updateError.message}`
      )
    })
  }
}

export const enqueueIngestion = (documentId, tenantId, filename, fileBuffer) =>
  limit(() => runIngestion(documentId, tenantId, filename, fileBuffer))
