import { Router } from 'express'
import multer from 'multer'

import { processDocument } from '../services/documentService.js'
import { generateEmbeddings } from '../services/embeddingService.js'

import { Document } from '../models/Document.js'
import { Tenant } from '../models/Tenant.js'

import { upsertVectors } from '../rag/vectorStore.js'

import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'

const router = Router({ mergeParams: true })

// Apply auth middleware to all routes
router.use(authenticate, requireTenant)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
})


router.post('/', upload.single('file'), async (req, res) => {
  let doc
  try {
    const { tenantId } = req.params
    const file = req.file

    if (!file) {
      return res.status(400).json({ error: 'No file uploaded' })
    }

    if (file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are supported'})
    }

    const tenant = await Tenant.findByPk(tenantId)

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' })
    }

    const { chunks, contentHash, numPages, metadata } = await processDocument( file.buffer, file.originalname )

    if (!chunks.length) {
      return res.status(400).json({ error: 'No extractable text found in document' })
    }

    doc = await Document.create({
      tenantId: tenant.id,
      filename: file.originalname,
      mimeType: file.mimetype,
      fileSize: file.size,
      contentHash,
      totalChunks: chunks.length,
      embeddingModel: 'nomic-embed-text',
      status: 'PROCESSING',
      processingStartedAt: new Date()
    })

    const embeddings = await generateEmbeddings(chunks)

    const vectorsToUpsert = embeddings.map(
      (embedding, index) => ({
        id: `${doc.id}-chunk-${index}`,
        values: embedding,
        metadata: {
          tenantId: tenant.id,
          documentId: doc.id,
          chunkIndex: index,
          text: chunks[index]
        }
      })
    )

    await upsertVectors( tenant.id, vectorsToUpsert )

    await doc.update({
      status: 'COMPLETED',
      processingCompletedAt: new Date()
    })  

    console.log(`[DOCUMENT API] Document processed and stored successfully: ${file.originalname} (Tenant: ${tenantId})`)

    return res.status(201).json({
      success: true,
      message: 'Document processed and embeddings stored successfully',
      documentId: doc.id,
      filename: file.originalname,
      chunksProcessed: chunks.length,
      pages: numPages
    })

  } catch (error) {
  
    if (doc) {
      await doc.update({
        status: 'FAILED',
        processingCompletedAt: new Date()
      })
    }

    console.error( 'Error processing document upload:', error )
    return res.status(500).json({ success: false, error: 'Internal server error'})
  }
})


router.get('/', async (req, res) => {
  try {
    const { tenantId } = req.params

    const documents = await Document.findAll({
      where: { tenantId },
      order: [['createdAt', 'DESC']],
      attributes: ['id', 'filename', 'mimeType', 'fileSize', 'totalChunks', 'status', 'createdAt']
    })

    console.log(`[DOCUMENT API] Fetched ${documents.length} documents for tenant: ${tenantId}`)

    return res.json({ success: true, documents })
  } catch (error) {
    console.error('Error fetching documents:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

export default router