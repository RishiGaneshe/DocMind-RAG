import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import cookieParser from 'cookie-parser'
import { initPinecone } from './rag/vectorStore.js'
import { config } from './config.js'
import { sequelize } from './services/db.js'
import { connectRedis, disconnectRedis } from './services/redisService.js'
import { User, Tenant, Document } from './models/index.js'

import authRoutes from './api/auth.js'
import tenantRoutes from './api/tenant.js'
import documentRoutes from './api/document.js'
import queryRoutes from './api/query.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

app.use(express.json())
app.use(cookieParser())
app.use(express.static(path.join(__dirname, 'public')))

app.use('/api/auth', authRoutes)
app.use('/api/tenants', tenantRoutes)
app.use('/api/tenants/:tenantId/documents', documentRoutes)
app.use('/api/tenants/:tenantId/query', queryRoutes)


const start = async () => {
  try {
    await sequelize.authenticate()
    console.log('PostgreSQL connected')

    await sequelize.sync({ alter: true })
    console.log('Database tables synced')

    await connectRedis()

    initPinecone().catch(err => {
      console.error('Failed to initialize Pinecone:', err)
    })

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
