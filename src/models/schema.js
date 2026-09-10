import { QueryTypes } from 'sequelize'
import { sequelize } from '../services/db.js'

const DEDUPE_INDEX_NAME = 'documents_tenant_content_hash_completed_idx'

// Ensure partial unique index on (tenantId, contentHash) for completed documents
export const ensureDocumentIndexes = async () => {
  const duplicates = await sequelize.query(
    `SELECT "tenantId", "contentHash", COUNT(*) AS n
       FROM "documents"
      WHERE "status" = 'COMPLETED'
      GROUP BY "tenantId", "contentHash"
     HAVING COUNT(*) > 1`,
    { type: QueryTypes.SELECT }
  )

  if (duplicates.length > 0) {
    const extra = duplicates.reduce((total, row) => total + (Number(row.n) - 1), 0)

    console.warn(
      `[SCHEMA] ${duplicates.length} duplicated (tenant, contentHash) group(s) ` +
        `hold ${extra} redundant document(s); skipping ${DEDUPE_INDEX_NAME}. ` +
        'Application-level deduplication still applies to new uploads.'
    )

    return { created: false, duplicates: duplicates.length }
  }

  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUPE_INDEX_NAME}
       ON "documents" ("tenantId", "contentHash")
       WHERE "status" = 'COMPLETED'`
  )

  console.log(`Document dedupe index ready: ${DEDUPE_INDEX_NAME}`)

  return { created: true, duplicates: 0 }
}

// Check if error is a unique constraint violation
export const isUniqueViolation = (error) =>
  error?.name === 'SequelizeUniqueConstraintError' ||
  error?.original?.code === '23505' ||
  error?.parent?.code === '23505'
