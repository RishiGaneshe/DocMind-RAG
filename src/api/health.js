import { Router } from 'express'
import { sequelize } from '../services/db.js'
import { getRedisSafe } from '../services/redisService.js'
import { isVectorStoreReady } from '../rag/vectorStore.js'
import { embeddingConfig, rerankConfig, llmConfig } from '../config.js'

const router = Router()

const checkPostgres = async () => {
  try {
    await sequelize.query('SELECT 1')

    return 'up'
  } catch {
    return 'down'
  }
}

/**
 * Liveness. Answers while the process is serving requests at all, so an
 * orchestrator does not restart a container that is merely waiting on a
 * dependency to come back.
 */
router.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() })
})

/**
 * Readiness. Postgres and Pinecone are both required for the query path, so
 * either being down means not ready. Redis is reported but not required:
 * caching is best-effort by design.
 *
 * Note that token blacklisting also lives in Redis and currently fails open,
 * so a Redis outage lets already-revoked access tokens work until they expire.
 */
router.get('/ready', async (req, res) => {
  const postgres = await checkPostgres()
  const redis = getRedisSafe() ? 'up' : 'down'
  const vectorStore = isVectorStoreReady() ? 'up' : 'down'

  const ready = postgres === 'up' && vectorStore === 'up'

  res.status(ready ? 200 : 503).json({
    ready,
    timestamp: new Date().toISOString(),
    dependencies: { postgres, redis, vectorStore },
    models: {
      embedding: `${embeddingConfig.model}@${embeddingConfig.dimension}`,
      rerank: rerankConfig.enabled ? rerankConfig.model : 'disabled',
      llm: llmConfig.model
    }
  })
})

export default router
