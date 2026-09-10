import dotenv from 'dotenv'
dotenv.config()

const num = (value, fallback) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

export const config = {
  port: num(process.env.PORT, 4500),
  databaseUrl: process.env.DATABASE_URL,
  nodeEnv: process.env.NODE_ENV || 'development',

  // ── Schema management ──
  // Migrations are the source of truth. `sync({ alter: true })` remains
  // available for local model experiments, but it is off unless asked for: it
  // cannot see the partial and expression indexes retrieval depends on and will
  // happily drop them.
  runMigrations: bool(process.env.DB_MIGRATE_ON_BOOT, true),
  syncAlter: bool(process.env.DB_SYNC_ALTER, false),
  
  allowedOrigins: (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  nvidiaAiKey: process.env.NVIDIA_AI_KEY,
  voyageApiKey: process.env.VOYAGE_API_KEY,

  pineconeApiKey: process.env.PINECONE_API_KEY,
  pineconeIndexName: process.env.PINECONE_INDEX_NAME || 'rag-index',
  pineconeCloud: process.env.PINECONE_CLOUD || 'aws',
  pineconeRegion: process.env.PINECONE_REGION || 'us-east-1',

  jwtSecret: process.env.JWT_SECRET,
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379'
}

export const embeddingConfig = {
  url: process.env.VOYAGE_EMBED_URL || 'https://api.voyageai.com/v1/embeddings',
  model: process.env.EMBEDDING_MODEL || 'voyage-4',
  dimension: num(process.env.EMBEDDING_DIMENSION, 1024),
  batchSize: num(process.env.EMBEDDING_BATCH_SIZE, 20),
  concurrency: num(process.env.EMBEDDING_CONCURRENCY, 4),
  requestTimeoutMs: num(process.env.EMBEDDING_TIMEOUT_MS, 60000),
  maxRetries: num(process.env.EMBEDDING_MAX_RETRIES, 5),
  maxInputChars: num(process.env.EMBEDDING_MAX_INPUT_CHARS, 24000)
}

export const rerankConfig = {
  enabled: bool(process.env.RERANK_ENABLED, true),
  url: process.env.VOYAGE_RERANK_URL || 'https://api.voyageai.com/v1/rerank',
  model: process.env.RERANK_MODEL || 'rerank-2.5',
  requestTimeoutMs: num(process.env.RERANK_TIMEOUT_MS, 30000),
  maxRetries: num(process.env.RERANK_MAX_RETRIES, 2),
  maxDocumentChars: num(process.env.RERANK_MAX_DOC_CHARS, 8000)
}

export const retrievalConfig = {
  candidateTopK: num(process.env.RETRIEVAL_CANDIDATE_TOP_K, 40),
  finalTopK: num(process.env.RETRIEVAL_FINAL_TOP_K, 6),
  maxFinalTopK: num(process.env.RETRIEVAL_MAX_FINAL_TOP_K, 20),
  minCosineScore: num(process.env.RETRIEVAL_MIN_COSINE, 0.15),
  minRerankScore: num(process.env.RETRIEVAL_MIN_RERANK, 0.3),
  relativeScoreFloor: num(process.env.RETRIEVAL_RELATIVE_FLOOR, 0.5),
  duplicateThreshold: num(process.env.RETRIEVAL_DUPLICATE_THRESHOLD, 0.85),
  hybridEnabled: bool(process.env.RETRIEVAL_HYBRID_ENABLED, true),
  rrfK: num(process.env.RETRIEVAL_RRF_K, 60)
}

export const llmConfig = {
  url: process.env.NVIDIA_URL || 'https://integrate.api.nvidia.com/v1/chat/completions',
  model: process.env.LLM_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b',
  temperature: num(process.env.LLM_TEMPERATURE, 0.2),
  topP: num(process.env.LLM_TOP_P, 0.9),
  maxTokens: num(process.env.LLM_MAX_TOKENS, 2048),
  requestTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 120000),
  maxRetries: num(process.env.LLM_MAX_RETRIES, 4),
  maxHistoryTurns: num(process.env.LLM_MAX_HISTORY_TURNS, 6),

  // Reasoning models leak their deliberation into the answer unless told to
  // keep it internal. `disableThinking` sends the NIM chat-template toggle
  // (dropped automatically if the provider rejects it); `noThinkDirective` is
  // the in-prompt lever some Nemotron builds use instead — set it to
  // `/no_think` if deliberation still comes through.
  disableThinking: bool(process.env.LLM_DISABLE_THINKING, true),
  noThinkDirective: process.env.LLM_NO_THINK_DIRECTIVE || ''
}

export const chunkingConfig = {
  version: num(process.env.CHUNKING_VERSION, 2),
  targetChars: num(process.env.CHUNK_TARGET_CHARS, 1400),
  overlapChars: num(process.env.CHUNK_OVERLAP_CHARS, 200),
  minChunkRatio: num(process.env.CHUNK_MIN_RATIO, 0.4),
  hardMaxChars: num(process.env.CHUNK_HARD_MAX_CHARS, 6000)
}

export const cacheConfig = {
  embeddingEnabled: bool(process.env.CACHE_EMBEDDING_ENABLED, true),
  embeddingTtlSeconds: num(process.env.CACHE_EMBEDDING_TTL, 60 * 60 * 24 * 7),
  answerEnabled: bool(process.env.CACHE_ANSWER_ENABLED, true),
  answerTtlSeconds: num(process.env.CACHE_ANSWER_TTL, 60 * 60),
  rerankEnabled: bool(process.env.CACHE_RERANK_ENABLED, true),
  rerankTtlSeconds: num(process.env.CACHE_RERANK_TTL, 60 * 60 * 6),
  rewriteEnabled: bool(process.env.CACHE_REWRITE_ENABLED, true),
  rewriteTtlSeconds: num(process.env.CACHE_REWRITE_TTL, 60 * 60 * 6)
}

export const uploadConfig = {
  maxFileBytes: num(process.env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
  maxConcurrentJobs: num(process.env.UPLOAD_MAX_CONCURRENT_JOBS, 2),
  dedupeEnabled: bool(process.env.UPLOAD_DEDUPE_ENABLED, true)
}

export const rateLimitConfig = {
  enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
  windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  generalMax: num(process.env.RATE_LIMIT_GENERAL_MAX, 300),
  queryMax: num(process.env.RATE_LIMIT_QUERY_MAX, 20),
  uploadMax: num(process.env.RATE_LIMIT_UPLOAD_MAX, 10),
  authMax: num(process.env.RATE_LIMIT_AUTH_MAX, 20)
}

export const publicApiConfig = {
  bodyLimit: process.env.PUBLIC_BODY_LIMIT || '32kb',
  windowSeconds: num(process.env.PUBLIC_RATE_WINDOW_SECONDS, 60),
  defaultRatePerMinute: num(process.env.PUBLIC_RATE_PER_MINUTE, 30),
  visitorRatePerMinute: num(process.env.PUBLIC_VISITOR_RATE_PER_MINUTE, 10),
  defaultDailyQuota: num(process.env.PUBLIC_DAILY_QUOTA, 500),
  keyCacheTtlSeconds: num(process.env.PUBLIC_KEY_CACHE_TTL, 300),
  keyNegativeCacheTtlSeconds: num(process.env.PUBLIC_KEY_NEGATIVE_CACHE_TTL, 30),
  lastUsedThrottleSeconds: num(process.env.PUBLIC_LAST_USED_THROTTLE, 60),
  requireOrigins: bool(process.env.PUBLIC_KEY_REQUIRE_ORIGINS, false),
  allowInsecureOrigins: bool(process.env.PUBLIC_ALLOW_INSECURE_ORIGINS, false),
  maxOriginsPerKey: num(process.env.PUBLIC_MAX_ORIGINS_PER_KEY, 20),
  maxQueryLength: num(process.env.PUBLIC_MAX_QUERY_LENGTH, 1000),
  maxHistoryTurns: num(process.env.PUBLIC_MAX_HISTORY_TURNS, 6),
  maxHistoryChars: num(process.env.PUBLIC_MAX_HISTORY_CHARS, 6000),
  maxTopK: num(process.env.PUBLIC_MAX_TOP_K, 6),
  rotationGraceHours: num(process.env.PUBLIC_ROTATION_GRACE_HOURS, 24),
  maxKeysPerTenant: num(process.env.PUBLIC_MAX_KEYS_PER_TENANT, 25)
}

export const WIDGET_SOURCE_MODES = ['full', 'labels', 'hidden']
export const DEFAULT_WIDGET_SOURCE_MODE =
  process.env.PUBLIC_DEFAULT_SOURCE_MODE || 'labels'

export const API_KEY_SCOPES = [
  'chat:query',
  'chat:config',
  'chat:filter',
  'documents:read',
  'documents:write'
]

export const DEFAULT_PUBLIC_SCOPES = ['chat:query', 'chat:config']
export const DEFAULT_SECRET_SCOPES = [
  'chat:query',
  'chat:config',
  'chat:filter',
  'documents:read'
]

export const NO_ANSWER_MESSAGE =
  "I don't have enough information to answer that confidently. Could you tell me a bit more about what you need?"
export const NO_ANSWER_SENTINEL = 'NOT_IN_CONTEXT'
