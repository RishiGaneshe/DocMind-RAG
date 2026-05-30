import dotenv from 'dotenv'
dotenv.config()

export const config = {
  port: process.env.PORT || 3000,
  databaseUrl: process.env.DATABASE_URL,
  geminiApiKey: process.env.GEMINI_API_KEY,
  groqApiKey: process.env.GROQ_API_KEY,
  pineconeApiKey: process.env.PINECONE_API_KEY,
  pineconeIndexName: process.env.PINECONE_INDEX_NAME || 'rag-index',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtAccessExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
  jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '7d',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379'
}
