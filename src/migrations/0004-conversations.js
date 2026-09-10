// Conversation and turn logging migration
const statements = [
  // ── enum ──
  `DO $$ BEGIN
     CREATE TYPE "enum_conversations_channel" AS ENUM ('dashboard', 'widget');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // ── conversations ──
  `CREATE TABLE IF NOT EXISTS "conversations" (
     "id" UUID PRIMARY KEY,
     "tenantId" UUID NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
     "userId" UUID NULL REFERENCES "users" ("id") ON DELETE SET NULL,
     "apiKeyId" UUID NULL REFERENCES "api_keys" ("id") ON DELETE SET NULL,
     "channel" "enum_conversations_channel" NOT NULL DEFAULT 'dashboard',
     "sessionId" VARCHAR(64) NULL,
     "title" VARCHAR(200) NULL,
     "turnCount" INTEGER NOT NULL DEFAULT 0,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS "conversations_tenant_created_idx"
     ON "conversations" ("tenantId", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS "conversations_tenant_user_idx"
     ON "conversations" ("tenantId", "userId")`,
  `CREATE INDEX IF NOT EXISTS "conversations_tenant_apikey_idx"
     ON "conversations" ("tenantId", "apiKeyId")`,
  `CREATE INDEX IF NOT EXISTS "conversations_tenant_session_idx"
     ON "conversations" ("tenantId", "sessionId")
     WHERE "sessionId" IS NOT NULL`,

  // ── conversation_turns ──
  `CREATE TABLE IF NOT EXISTS "conversation_turns" (
     "id" UUID PRIMARY KEY,
     "conversationId" UUID NOT NULL REFERENCES "conversations" ("id") ON DELETE CASCADE,
     "tenantId" UUID NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
     "turnIndex" INTEGER NOT NULL DEFAULT 0,

     -- Question
     "query" TEXT NOT NULL,
     "searchQuery" TEXT NULL,
     "rewritten" BOOLEAN NOT NULL DEFAULT FALSE,

     -- Answer
     "answer" TEXT NOT NULL,
     "noAnswer" BOOLEAN NOT NULL DEFAULT FALSE,
     "cached" BOOLEAN NOT NULL DEFAULT FALSE,

     -- Retrieval metadata
     "chunksUsed" INTEGER NOT NULL DEFAULT 0,
     "sources" JSONB NOT NULL DEFAULT '[]'::jsonb,
     "citedSources" INTEGER[] NOT NULL DEFAULT '{}',
     "retrievalStage" VARCHAR(32) NULL,
     "retrievalStats" JSONB NOT NULL DEFAULT '{}'::jsonb,

     -- Performance
     "responseTimeMs" INTEGER NULL,
     "streamMode" BOOLEAN NOT NULL DEFAULT FALSE,

     -- Models used
     "llmModel" VARCHAR(100) NULL,
     "embeddingModel" VARCHAR(100) NULL,

     -- User feedback (future)
     "feedbackRating" SMALLINT NULL,
     "feedbackNote" TEXT NULL,
     "feedbackAt" TIMESTAMPTZ NULL,

     -- Knowledge promotion (future)
     "promotedAt" TIMESTAMPTZ NULL,
     "promotedChunkId" VARCHAR(128) NULL,

     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  `CREATE INDEX IF NOT EXISTS "conversation_turns_conversation_idx"
     ON "conversation_turns" ("conversationId", "turnIndex")`,
  `CREATE INDEX IF NOT EXISTS "conversation_turns_tenant_created_idx"
     ON "conversation_turns" ("tenantId", "createdAt" DESC)`,
  // Candidates for knowledge promotion: answered turns not yet promoted.
  `CREATE INDEX IF NOT EXISTS "conversation_turns_promotable_idx"
     ON "conversation_turns" ("tenantId")
     WHERE "promotedAt" IS NULL AND "noAnswer" = FALSE`,
  // Turns with feedback, for analytics.
  `CREATE INDEX IF NOT EXISTS "conversation_turns_feedback_idx"
     ON "conversation_turns" ("tenantId")
     WHERE "feedbackRating" IS NOT NULL`
]

export const up = async ({ context: sequelize }) => {
  for (const statement of statements) {
    await sequelize.query(statement)
  }
}

export const down = async ({ context: sequelize }) => {
  await sequelize.query(`DROP TABLE IF EXISTS "conversation_turns"`)
  await sequelize.query(`DROP TABLE IF EXISTS "conversations"`)
  await sequelize.query(`DROP TYPE IF EXISTS "enum_conversations_channel"`)
}
