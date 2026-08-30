import 'dotenv/config'
import express from 'express'
import cookieParser from 'cookie-parser'
import cors from 'cors'
import helmet from 'helmet'
import path from 'path'
import { fileURLToPath } from 'url'
import { initPinecone } from './rag/vectorStore.js'
import { ensureLexicalIndex } from './rag/chunkStore.js'
import { ensureDocumentIndexes } from './models/schema.js'
import { config } from './config.js'
import { sequelize } from './services/db.js'
import { runMigrations, pendingMigrations } from './services/migrator.js'
import { connectRedis, disconnectRedis } from './services/redisService.js'
import { User, Tenant, Document, DocumentChunk } from './models/index.js'

import authRoutes from './api/auth.js'
import tenantRoutes from './api/tenant.js'
import documentRoutes from './api/document.js'
import queryRoutes from './api/query.js'
import healthRoutes from './api/health.js'
import { errorHandler } from './middleware/errorHandler.js'
import { generalLimiter, authLimiter } from './middleware/rateLimit.js'

const app = express()

app.set('trust proxy', 1)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false
  })
)

app.use(
  cors({
    origin: config.allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
)

app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())

app.use(healthRoutes)
app.use('/api', healthRoutes)

app.use('/api', generalLimiter)

app.use('/api/auth', authLimiter, authRoutes)
app.use('/api/tenants', tenantRoutes)
app.use('/api/tenants/:tenantId/documents', documentRoutes)
app.use('/api/tenants/:tenantId/query', queryRoutes)

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

app.use(express.static(path.join(__dirname, '../frontend/dist')))

app.use((req, res, next) => {
  if (req.method !== 'GET' || req.originalUrl.startsWith('/api')) {
    return next()
  }
  res.sendFile(path.join(__dirname, '../frontend/dist/index.html'))
})

app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.originalUrl })
})

app.use(errorHandler)

const start = async () => {
  try {
    await sequelize.authenticate()
    console.log('PostgreSQL connected')

    if (config.runMigrations) {
      await runMigrations()
    } else {
      const pending = await pendingMigrations()

      if (pending.length > 0) {
        console.warn(
          `[MIGRATE] ${pending.length} migration(s) pending and ` +
            'DB_MIGRATE_ON_BOOT is off: ' +
            pending.join(', ')
        )
      }
    }

    if (config.syncAlter) {
      console.warn(
        'DB_SYNC_ALTER is on. sync({ alter: true }) may drop indexes it ' +
          'cannot see, including the lexical GIN index.'
      )

      await sequelize.sync({ alter: true })
      console.log('Database tables synced')
    }

    try {
      await ensureLexicalIndex()
    } catch (error) {
      console.error('Lexical index creation failed:', error.message)
      console.error('Retrieval will run dense-only until this is resolved.')
    }

    try {
      await ensureDocumentIndexes()
    } catch (error) {
      console.error('Document index creation failed:', error.message)
    }

    await connectRedis()

    try {
      await initPinecone()
    } catch (error) {
      console.error('Pinecone initialization failed:', error.message)
      console.error('The server will start, but /api/ready will report 503.')
    }

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`)
    })
  } catch (error) {
    console.error('Failed to start server:', error)
    process.exit(1)
  }
}


const shutdown = async (signal) => {
  console.log(`\n${signal} received. Shutting down gracefully...`)
  try {
    await disconnectRedis()
    await sequelize.close()
    console.log('All connections closed')
    process.exit(0)
  } catch (err) {
    console.error('Error during shutdown:', err)
    process.exit(1)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

start()

export default app
