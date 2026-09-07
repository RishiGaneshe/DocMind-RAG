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
import { User, Tenant, Document, DocumentChunk, ApiKey } from './models/index.js'

import authRoutes from './api/auth.js'
import tenantRoutes from './api/tenant.js'
import documentRoutes from './api/document.js'
import queryRoutes from './api/query.js'
import healthRoutes from './api/health.js'
import apiKeyRoutes from './api/apiKeys.js'
import widgetRoutes from './api/widget.js'
import publicChatRoutes from './api/publicChat.js'
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

/**
 * The public widget surface, mounted ahead of the global CORS and JSON parser
 * because both are shaped for the dashboard and wrong here.
 *
 * CORS: the `cors` package answers every preflight itself and merely omits
 * `Access-Control-Allow-Origin` when the origin is not on the allowlist. Mounted
 * below it, this router's `OPTIONS` would be answered against the dashboard's
 * allowlist and every widget on a customer site would fail before any of our
 * code ran. A preflight carries no `X-Api-Key`, so per-key origin enforcement
 * cannot happen there — it happens in `originGuard`, once the key is resolved.
 *
 * JSON: this router parses at 32kb rather than 1mb, because that parse is the one
 * cost an unidentified caller can impose.
 *
 * It also sits above `app.use('/api', generalLimiter)` on purpose. That limiter
 * keeps its counters in process memory, so N instances would allow N times the
 * limit; public traffic is bounded instead by the Redis counters in
 * `enforceQuota`, which hold across processes.
 */
app.use('/api/public', publicChatRoutes)

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
app.use('/api/tenants/:tenantId/api-keys', apiKeyRoutes)
app.use('/api/tenants/:tenantId/widget', widgetRoutes)
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
