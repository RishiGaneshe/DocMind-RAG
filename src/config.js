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
  
  // ── CORS ──
  allowedOrigins: (process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // ── LLM providers ──
  nvidiaAiKey: process.env.NVIDIA_AI_KEY,
  voyageApiKey: process.env.VOYAGE_API_KEY,

  // ── Vector store ──
  pineconeApiKey: process.env.PINECONE_API_KEY,
  pineconeIndexName: process.env.PINECONE_INDEX_NAME || 'rag-index',
  pineconeCloud: process.env.PINECONE_CLOUD || 'aws',
  pineconeRegion: process.env.PINECONE_REGION || 'us-east-1',

  // ── Auth ──
  jwtSecret: process.env.JWT_SECRET,
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379'
}

// ── Embeddings ──
export const embeddingConfig = {
  url: process.env.VOYAGE_EMBED_URL || 'https://api.voyageai.com/v1/embeddings',
  model: process.env.EMBEDDING_MODEL || 'voyage-4',
  dimension: num(process.env.EMBEDDING_DIMENSION, 1024),
  batchSize: num(process.env.EMBEDDING_BATCH_SIZE, 20),
  concurrency: num(process.env.EMBEDDING_CONCURRENCY, 4),
  requestTimeoutMs: num(process.env.EMBEDDING_TIMEOUT_MS, 60000),
  maxRetries: num(process.env.EMBEDDING_MAX_RETRIES, 5),
  // Voyage voyage-4 accepts 32k tokens per input; this ceiling is a guard
  // against pathological chunks, not a routine truncation point.
  maxInputChars: num(process.env.EMBEDDING_MAX_INPUT_CHARS, 24000)
}

// ── Reranking ──
export const rerankConfig = {
  enabled: bool(process.env.RERANK_ENABLED, true),
  url: process.env.VOYAGE_RERANK_URL || 'https://api.voyageai.com/v1/rerank',
  model: process.env.RERANK_MODEL || 'rerank-2.5',
  requestTimeoutMs: num(process.env.RERANK_TIMEOUT_MS, 30000),
  maxRetries: num(process.env.RERANK_MAX_RETRIES, 2),
  // rerank-2.5 allows 32k tokens per query+document pair.
  maxDocumentChars: num(process.env.RERANK_MAX_DOC_CHARS, 8000)
}

// ── Retrieval ──
export const retrievalConfig = {
  // Wide first-stage recall, narrowed by the reranker.
  candidateTopK: num(process.env.RETRIEVAL_CANDIDATE_TOP_K, 40),
  finalTopK: num(process.env.RETRIEVAL_FINAL_TOP_K, 6),
  maxFinalTopK: num(process.env.RETRIEVAL_MAX_FINAL_TOP_K, 20),
  // Absolute cosine floor. Measured natural-language queries against
  // voyage-4 score 0.20-0.31, so this is a noise gate and nothing more.
  // Relevance filtering is the reranker's job.
  minCosineScore: num(process.env.RETRIEVAL_MIN_COSINE, 0.15),
  // Applied to rerank relevance scores, which spread far more usefully.
  minRerankScore: num(process.env.RETRIEVAL_MIN_RERANK, 0.3),
  // Keep a candidate only if it scores within this fraction of the best hit.
  relativeScoreFloor: num(process.env.RETRIEVAL_RELATIVE_FLOOR, 0.5),
  // Jaccard trigram similarity above which two chunks count as duplicates.
  duplicateThreshold: num(process.env.RETRIEVAL_DUPLICATE_THRESHOLD, 0.85),
  hybridEnabled: bool(process.env.RETRIEVAL_HYBRID_ENABLED, true),
  // Reciprocal Rank Fusion smoothing constant.
  rrfK: num(process.env.RETRIEVAL_RRF_K, 60)
}

// ── Generation ──
export const llmConfig = {
  url: process.env.NVIDIA_URL || 'https://integrate.api.nvidia.com/v1/chat/completions',
  // Benchmarked 2026-08-31: fastest model on this key that honours the
  // citation and refusal contract. See RAG_ENHANCEMENT_PLAN.md section 1.7.
  model: process.env.LLM_MODEL || 'meta/llama-3.2-11b-vision-instruct',
  temperature: num(process.env.LLM_TEMPERATURE, 0.2),
  topP: num(process.env.LLM_TOP_P, 0.9),
  maxTokens: num(process.env.LLM_MAX_TOKENS, 2048),
  requestTimeoutMs: num(process.env.LLM_TIMEOUT_MS, 120000),
  maxRetries: num(process.env.LLM_MAX_RETRIES, 2),
  maxHistoryTurns: num(process.env.LLM_MAX_HISTORY_TURNS, 6)
}

// ── Chunking ──
export const chunkingConfig = {
  // Bumped whenever the parser or splitter changes shape, so retrieval can
  // tell which pipeline produced a given chunk.
  version: num(process.env.CHUNKING_VERSION, 2),
  targetChars: num(process.env.CHUNK_TARGET_CHARS, 1400),
  overlapChars: num(process.env.CHUNK_OVERLAP_CHARS, 200),
  // Tails shorter than this fraction of target are merged backwards.
  minChunkRatio: num(process.env.CHUNK_MIN_RATIO, 0.4),
  hardMaxChars: num(process.env.CHUNK_HARD_MAX_CHARS, 6000)
}

// ── Caching ──
export const cacheConfig = {
  embeddingEnabled: bool(process.env.CACHE_EMBEDDING_ENABLED, true),
  embeddingTtlSeconds: num(process.env.CACHE_EMBEDDING_TTL, 60 * 60 * 24 * 7),
  answerEnabled: bool(process.env.CACHE_ANSWER_ENABLED, true),
  answerTtlSeconds: num(process.env.CACHE_ANSWER_TTL, 60 * 60),
  rerankEnabled: bool(process.env.CACHE_RERANK_ENABLED, true),
  rerankTtlSeconds: num(process.env.CACHE_RERANK_TTL, 60 * 60 * 6)
}

// ── Uploads ──
export const uploadConfig = {
  maxFileBytes: num(process.env.UPLOAD_MAX_BYTES, 10 * 1024 * 1024),
  // Ingestion runs after the response is sent, so the client is not held open
  // for the minute or more a long PDF takes to embed. Bounded so a burst of
  // uploads cannot start an unlimited number of concurrent pipelines.
  maxConcurrentJobs: num(process.env.UPLOAD_MAX_CONCURRENT_JOBS, 2),
  // Re-uploading an identical file returns the existing document instead of
  // paying to embed it twice.
  dedupeEnabled: bool(process.env.UPLOAD_DEDUPE_ENABLED, true)
}

// ── Rate limiting ──
// Every /query request costs three paid API calls, so the query limit is far
// tighter than the general one.
export const rateLimitConfig = {
  enabled: bool(process.env.RATE_LIMIT_ENABLED, true),
  windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
  generalMax: num(process.env.RATE_LIMIT_GENERAL_MAX, 300),
  queryMax: num(process.env.RATE_LIMIT_QUERY_MAX, 20),
  uploadMax: num(process.env.RATE_LIMIT_UPLOAD_MAX, 10),
  authMax: num(process.env.RATE_LIMIT_AUTH_MAX, 20)
}

// ── Public (API-key) surface ──
// The widget route is the only internet-facing, unauthenticated entry point, so
// every limit here is deliberately tighter than its dashboard equivalent. A key
// embedded in a browser bundle is public by construction; these values, not the
// key's secrecy, are what bound the damage.
export const publicApiConfig = {
  // Request body ceiling. A question plus six turns of history fits in a few KB;
  // anything larger is either a mistake or an attempt to inflate token cost.
  bodyLimit: process.env.PUBLIC_BODY_LIMIT || '32kb',

  // Per-key and per-visitor windows, both enforced in Redis so they hold across
  // processes rather than per-instance like `express-rate-limit`'s memory store.
  windowSeconds: num(process.env.PUBLIC_RATE_WINDOW_SECONDS, 60),
  defaultRatePerMinute: num(process.env.PUBLIC_RATE_PER_MINUTE, 30),
  visitorRatePerMinute: num(process.env.PUBLIC_VISITOR_RATE_PER_MINUTE, 10),
  defaultDailyQuota: num(process.env.PUBLIC_DAILY_QUOTA, 500),

  // Resolved-key cache. Short enough that a revocation which somehow bypassed
  // the explicit cache invalidation still expires on its own.
  keyCacheTtlSeconds: num(process.env.PUBLIC_KEY_CACHE_TTL, 300),
  // Unknown keys are cached too, so a flood of garbage keys cannot be turned
  // into a flood of database lookups.
  keyNegativeCacheTtlSeconds: num(process.env.PUBLIC_KEY_NEGATIVE_CACHE_TTL, 30),
  // `lastUsedAt` is a nice-to-have, not an audit log. Writing it on every
  // message would mean one UPDATE per chat turn.
  lastUsedThrottleSeconds: num(process.env.PUBLIC_LAST_USED_THROTTLE, 60),

  // Refuse to mint a key with no origin allowlist. Off by default because a new
  // key that rejects everything looks broken; the API reports `unrestricted`
  // instead so the dashboard can warn.
  requireOrigins: bool(process.env.PUBLIC_KEY_REQUIRE_ORIGINS, false),
  // Plain http origins carry no confidentiality and invite mixed-content
  // failures. Loopback is always allowed so local development works.
  allowInsecureOrigins: bool(process.env.PUBLIC_ALLOW_INSECURE_ORIGINS, false),
  maxOriginsPerKey: num(process.env.PUBLIC_MAX_ORIGINS_PER_KEY, 20),

  // Question and history ceilings, independent of the dashboard's.
  maxQueryLength: num(process.env.PUBLIC_MAX_QUERY_LENGTH, 1000),
  maxHistoryTurns: num(process.env.PUBLIC_MAX_HISTORY_TURNS, 6),
  maxHistoryChars: num(process.env.PUBLIC_MAX_HISTORY_CHARS, 6000),
  // A public caller cannot widen retrieval and so cannot widen the rerank and
  // generation bill.
  maxTopK: num(process.env.PUBLIC_MAX_TOP_K, 6),

  // Hours an old secret keeps working after a rotation.
  rotationGraceHours: num(process.env.PUBLIC_ROTATION_GRACE_HOURS, 24),

  maxKeysPerTenant: num(process.env.PUBLIC_MAX_KEYS_PER_TENANT, 25)
}

// How much of a retrieved source an anonymous visitor may see. `labels` keeps
// citations useful without shipping raw chunk text or internal document ids.
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
  'I could not find any relevant information in the uploaded documents to answer your question.'
// Sentinel the model is instructed to emit when the context is insufficient.
export const NO_ANSWER_SENTINEL = 'NOT_IN_CONTEXT'
