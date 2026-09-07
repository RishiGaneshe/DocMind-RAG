/**
 * API keys and widget configuration.
 *
 * Keys live in their own table rather than as a column on `tenants` because one
 * workspace needs several of them: a public key per site the widget is embedded
 * on, plus secret keys for server-to-server work. A single column cannot be
 * rotated without downtime and cannot be revoked at all.
 *
 * Only `keyHash` is stored, never the key. `keyPrefix` and `keyLast4` exist so
 * the dashboard can name a key in a list without us retaining anything that
 * could authenticate.
 *
 * Written `IF NOT EXISTS` throughout to match the baseline's contract: applying
 * this to a database that already has the table must be a no-op.
 */

const statements = [
  `DO $$ BEGIN
     CREATE TYPE "enum_api_keys_type" AS ENUM ('public', 'secret');
   EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `CREATE TABLE IF NOT EXISTS "api_keys" (
     "id" UUID PRIMARY KEY,
     "tenantId" UUID NOT NULL REFERENCES "tenants" ("id") ON DELETE CASCADE,
     "createdBy" UUID NULL REFERENCES "users" ("id") ON DELETE SET NULL,
     "name" VARCHAR(80) NOT NULL,
     "type" "enum_api_keys_type" NOT NULL DEFAULT 'public',
     "keyPrefix" VARCHAR(32) NOT NULL,
     "keyLast4" VARCHAR(4) NOT NULL,
     "keyHash" VARCHAR(64) NOT NULL UNIQUE,
     "scopes" TEXT[] NOT NULL DEFAULT '{}',
     "allowedOrigins" TEXT[] NOT NULL DEFAULT '{}',
     "rateLimitPerMinute" INTEGER NULL,
     "dailyQuota" INTEGER NULL,
     "lastUsedAt" TIMESTAMPTZ NULL,
     "lastUsedIp" VARCHAR(64) NULL,
     "totalRequests" BIGINT NOT NULL DEFAULT 0,
     "expiresAt" TIMESTAMPTZ NULL,
     "revokedAt" TIMESTAMPTZ NULL,
     "rotatedFromId" UUID NULL,
     "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,

  // The hot path: one indexed equality per authenticated public request.
  `CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_idx"
     ON "api_keys" ("keyHash")`,
  `CREATE INDEX IF NOT EXISTS "api_keys_tenant_id_idx"
     ON "api_keys" ("tenantId")`,
  // Partial, because the dashboard list only ever wants live keys and revoked
  // rows are retained indefinitely for audit.
  `CREATE INDEX IF NOT EXISTS "api_keys_tenant_active_idx"
     ON "api_keys" ("tenantId", "createdAt")
     WHERE "revokedAt" IS NULL`,

  // Widget branding and the source-exposure mode the public route redacts
  // against. JSONB rather than a side table: it is strictly 1:1 with a tenant
  // and is read on every widget bootstrap.
  `ALTER TABLE "tenants"
     ADD COLUMN IF NOT EXISTS "widgetConfig" JSONB NOT NULL DEFAULT '{}'::jsonb`
]

export const up = async ({ context: sequelize }) => {
  for (const statement of statements) {
    await sequelize.query(statement)
  }
}

export const down = async ({ context: sequelize }) => {
  await sequelize.query(`DROP TABLE IF EXISTS "api_keys"`)
  await sequelize.query(`DROP TYPE IF EXISTS "enum_api_keys_type"`)
  await sequelize.query(`ALTER TABLE "tenants" DROP COLUMN IF EXISTS "widgetConfig"`)
}
