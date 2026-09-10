// Baseline database schema
const statements = [
  // Enum types
  `DO $$ BEGIN
     CREATE TYPE "enum_users_role" AS ENUM ('owner', 'member');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `DO $$ BEGIN
     CREATE TYPE "enum_documents_status" AS ENUM
       ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  // ── users ──
  `CREATE TABLE IF NOT EXISTS "users" (
     "id" UUID PRIMARY KEY,
     "email" VARCHAR(255) NOT NULL UNIQUE,
     "password" VARCHAR(255) NOT NULL,
     "firstName" VARCHAR(255) NOT NULL,
     "lastName" VARCHAR(255) NOT NULL,
     "tenantId" UUID NULL DEFAULT NULL,
     "role" "enum_users_role" NOT NULL DEFAULT 'owner',
     "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
     "lastLoginAt" TIMESTAMPTZ NULL,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email")`,
  `CREATE INDEX IF NOT EXISTS "users_tenant_id_idx" ON "users" ("tenantId")`,

  // ── tenants ──
  `CREATE TABLE IF NOT EXISTS "tenants" (
     "id" UUID PRIMARY KEY,
     "name" VARCHAR(255) NOT NULL,
     "slug" VARCHAR(255) NOT NULL UNIQUE,
     "ownerId" UUID NOT NULL,
     "apiKey" VARCHAR(255) UNIQUE,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_idx" ON "tenants" ("slug")`,
  `CREATE INDEX IF NOT EXISTS "tenants_owner_id_idx" ON "tenants" ("ownerId")`,

  // ── documents ──
  `CREATE TABLE IF NOT EXISTS "documents" (
     "id" UUID PRIMARY KEY,
     "tenantId" UUID NOT NULL REFERENCES "tenants" ("id"),
     "filename" VARCHAR(255) NOT NULL,
     "mimeType" VARCHAR(255) NOT NULL,
     "fileSize" INTEGER NOT NULL,
     "contentHash" VARCHAR(64) NOT NULL,
     "totalChunks" INTEGER NOT NULL DEFAULT 0,
     "numPages" INTEGER NULL,
     "embeddingModel" VARCHAR(255) NOT NULL,
     "status" "enum_documents_status" NOT NULL DEFAULT 'PENDING',
     "processingStartedAt" TIMESTAMPTZ NULL,
     "processingCompletedAt" TIMESTAMPTZ NULL,
     "failureReason" TEXT NULL,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  // Present on the fresh path via the CREATE above; added here for the database
  // that predates the column.
  `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "numPages" INTEGER NULL`,
  `CREATE INDEX IF NOT EXISTS "documents_tenant_id_idx" ON "documents" ("tenantId")`,
  `CREATE INDEX IF NOT EXISTS "documents_status_idx" ON "documents" ("status")`,
  `CREATE INDEX IF NOT EXISTS "documents_tenant_hash_idx"
     ON "documents" ("tenantId", "contentHash")`,
  `CREATE INDEX IF NOT EXISTS "documents_tenant_created_idx"
     ON "documents" ("tenantId", "createdAt")`,

  // ── document_chunks ──
  `CREATE TABLE IF NOT EXISTS "document_chunks" (
     "id" VARCHAR(128) PRIMARY KEY,
     "tenantId" UUID NOT NULL REFERENCES "tenants" ("id"),
     "documentId" UUID NOT NULL REFERENCES "documents" ("id") ON DELETE CASCADE,
     "chunkIndex" INTEGER NOT NULL,
     "text" TEXT NOT NULL,
     "charCount" INTEGER NOT NULL DEFAULT 0,
     "pageStart" INTEGER NULL,
     "pageEnd" INTEGER NULL,
     "heading" VARCHAR(512) NULL,
     "breadcrumb" VARCHAR(768) NULL,
     "chunkingVersion" INTEGER NOT NULL DEFAULT 2,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS "document_chunks_tenant_id_idx"
     ON "document_chunks" ("tenantId")`,
  `CREATE INDEX IF NOT EXISTS "document_chunks_document_id_idx"
     ON "document_chunks" ("documentId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "document_chunks_document_chunk_idx"
     ON "document_chunks" ("documentId", "chunkIndex")`
]

export const up = async ({ context: sequelize }) => {
  for (const statement of statements) {
    await sequelize.query(statement)
  }
}

export const down = async () => {
  throw new Error(
    'The baseline migration is not reversible: reverting it would drop every table.'
  )
}
