import { QueryTypes } from 'sequelize'
import { sequelize } from '../services/db.js'

const DEDUPE_INDEX_NAME = 'documents_tenant_content_hash_completed_idx'

/**
 * Partial unique index on `(tenantId, contentHash)` over successful documents
 * only.
 *
 * Partial on purpose. A plain unique index would also refuse a retry of a
 * document whose first attempt FAILED, and it would refuse the second of two
 * uploads racing on the same file even though only one of them will ever reach
 * COMPLETED. Restricting the constraint to `status = 'COMPLETED'` enforces the
 * property that actually matters — one stored copy of any given file per tenant
 * — and leaves the rest of the lifecycle alone.
 *
 * Declared here rather than in the model because `sequelize.sync({ alter: true })`
 * cannot express a `WHERE` clause, and because a pre-existing duplicate must
 * degrade to a warning rather than a failed boot.
 */
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

/**
 * Postgres raises 23505 on a unique violation. Sequelize surfaces it as
 * `UniqueConstraintError`, but a raw query or a bulk write can surface the
 * driver error directly, so both shapes are recognised.
 */
export const isUniqueViolation = (error) =>
  error?.name === 'SequelizeUniqueConstraintError' ||
  error?.original?.code === '23505' ||
  error?.parent?.code === '23505'
