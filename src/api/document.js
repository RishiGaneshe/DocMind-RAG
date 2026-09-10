import { Router } from 'express'
import multer from 'multer'
import { Op } from 'sequelize'

import { hashBuffer } from '../services/documentService.js'
import {
  enqueueIngestion,
  ingestionLoad,
  ingestionSaturated
} from '../services/ingestionService.js'
import { EMBEDDING_MODEL } from '../services/embeddingService.js'
import { bumpCorpusVersion } from '../services/cacheService.js'

import { Document } from '../models/Document.js'
import { isUniqueViolation } from '../models/schema.js'

import { deleteVectors, listVectorIds } from '../rag/vectorStore.js'
import { deleteChunksForDocument, buildChunkId } from '../rag/chunkStore.js'

import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'
import { uploadLimiter } from '../middleware/rateLimit.js'
import { uploadConfig } from '../config.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireTenant)

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const LIST_ATTRIBUTES = [
  'id',
  'filename',
  'mimeType',
  'fileSize',
  'totalChunks',
  'numPages',
  'status',
  'failureReason',
  'processingStartedAt',
  'processingCompletedAt',
  'createdAt'
]

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadConfig.maxFileBytes }
})

const handleUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next()

    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = Math.floor(uploadConfig.maxFileBytes / (1024 * 1024))

      return res.status(413).json({
        success: false,
        error: `File size should be less than ${mb} MB due to the LLM processing load`
      })
    }

    return res.status(400).json({
      success: false,
      error: err.message || 'File upload failed'
    })
  })
}

const findDuplicate = async (tenantId, contentHash) =>
  await Document.findOne({
    where: {
      tenantId,
      contentHash,
      status: { [Op.in]: ['PENDING', 'PROCESSING', 'COMPLETED'] }
    },
    order: [['createdAt', 'DESC']],
    attributes: LIST_ATTRIBUTES.concat('contentHash')
  })

router.post('/', uploadLimiter, handleUpload, async (req, res) => {
  try {
    const { tenantId } = req.params
    const file = req.file

    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' })
    }

    if (file.mimetype !== 'application/pdf') {
      return res
        .status(415)
        .json({ success: false, error: 'Only PDF files are supported' })
    }

    if (ingestionSaturated()) {
      const load = ingestionLoad()

      console.warn(
        `[DOCUMENT API] ingestion queue full (${load.queued}/${load.capacity})`
      )

      return res.status(503).json({
        success: false,
        error: 'The ingestion queue is full. Please retry in a few minutes.',
        code: 'INGESTION_BUSY',
        queued: load.queued
      })
    }

    const contentHash = hashBuffer(file.buffer)

    if (uploadConfig.dedupeEnabled) {
      const existing = await findDuplicate(tenantId, contentHash)

      if (existing) {
        console.log(
          `[DOCUMENT API] duplicate upload of ${file.originalname} ` +
            `(tenant ${tenantId}) resolved to ${existing.id}`
        )

        return res.status(200).json({
          success: true,
          duplicate: true,
          message: 'This file has already been uploaded.',
          document: existing
        })
      }
    }

    let doc

    try {
      doc = await Document.create({
        tenantId,
        filename: file.originalname,
        mimeType: file.mimetype,
        fileSize: file.size,
        contentHash,
        totalChunks: 0,
        embeddingModel: EMBEDDING_MODEL,
        status: 'PENDING'
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error

      const existing = await findDuplicate(tenantId, contentHash)

      if (!existing) throw error

      return res.status(200).json({
        success: true,
        duplicate: true,
        message: 'This file has already been uploaded.',
        document: existing
      })
    }

    enqueueIngestion(doc.id, tenantId, file.originalname, file.buffer)

    const load = ingestionLoad()

    return res.status(202).json({
      success: true,
      message: 'Upload accepted. Processing has been queued.',
      documentId: doc.id,
      filename: doc.filename,
      status: doc.status,
      statusUrl: `/api/tenants/${tenantId}/documents/${doc.id}`,
      queuePosition: load.queued
    })
  } catch (error) {
    console.error('Error accepting document upload:', error)

    return res
      .status(500)
      .json({ success: false, error: 'Internal server error' })
  }
})

router.get('/', async (req, res) => {
  try {
    const { tenantId } = req.params

    const documents = await Document.findAll({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
      attributes: LIST_ATTRIBUTES
    })

    console.log(
      `[DOCUMENT API] Fetched ${documents.length} documents for tenant: ${tenantId}`
    )

    return res.json({ success: true, documents })
  } catch (error) {
    console.error('Error fetching documents:', error)

    return res
      .status(500)
      .json({ success: false, error: 'Internal server error' })
  }
})

router.get('/:documentId', async (req, res) => {
  try {
    const { tenantId, documentId } = req.params

    if (!UUID_PATTERN.test(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document id' })
    }

    const document = await Document.findOne({
      where: { tenantId, id: documentId },
      attributes: LIST_ATTRIBUTES
    })

    if (!document) {
      return res.status(404).json({ success: false, error: 'Document not found' })
    }

    return res.json({
      success: true,
      document,
      // `PENDING` and `PROCESSING` are the only states worth polling.
      processing: document.status === 'PENDING' || document.status === 'PROCESSING'
    })
  } catch (error) {
    console.error('Error fetching document:', error)

    return res
      .status(500)
      .json({ success: false, error: 'Internal server error' })
  }
})

const collectVectorIds = async (tenantId, document) => {
  const ids = new Set()

  for (let index = 0; index < (document.totalChunks ?? 0); index++) {
    ids.add(buildChunkId(document.id, index))
  }

  try {
    let paginationToken

    do {
      const page = await listVectorIds(tenantId, {
        prefix: `${document.id}-chunk-`,
        paginationToken
      })

      page.ids.forEach((id) => ids.add(id))
      paginationToken = page.next
    } while (paginationToken)
  } catch (error) {
    console.warn(
      `[DOCUMENT API] prefix listing failed for ${document.id} ` +
        `(${error.message}); falling back to the ${ids.size} derived id(s)`
    )
  }

  return [...ids]
}

router.delete('/:documentId', async (req, res) => {
  try {
    const { tenantId, documentId } = req.params

    if (!UUID_PATTERN.test(documentId)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid document id' })
    }

    const document = await Document.findOne({
      where: { tenantId, id: documentId }
    })

    if (!document) {
      return res.status(404).json({ success: false, error: 'Document not found' })
    }

    if (document.status === 'PENDING' || document.status === 'PROCESSING') {
      return res.status(409).json({
        success: false,
        error: 'This document is still being processed. Try again once it finishes.',
        code: 'DOCUMENT_BUSY',
        status: document.status
      })
    }

    const vectorIds = await collectVectorIds(tenantId, document)

    if (vectorIds.length > 0) {
      await deleteVectors(tenantId, vectorIds)
    }

    const removedChunks = await deleteChunksForDocument(tenantId, documentId)

    await document.destroy()

    await bumpCorpusVersion(tenantId)

    console.log(
      `[DOCUMENT API] Deleted ${documentId} (tenant ${tenantId}): ` +
        `${vectorIds.length} vector(s), ${removedChunks} chunk row(s)`
    )

    return res.json({
      success: true,
      message: 'Document deleted',
      documentId,
      vectorsDeleted: vectorIds.length,
      chunksDeleted: removedChunks
    })
  } catch (error) {
    console.error('Error deleting document:', error)

    if (error.code === 'VECTOR_STORE_NOT_READY') {
      return res.status(503).json({
        success: false,
        error: 'Vector store is not ready, so the document was left in place.'
      })
    }

    return res
      .status(500)
      .json({ success: false, error: 'Internal server error' })
  }
})

export default router
