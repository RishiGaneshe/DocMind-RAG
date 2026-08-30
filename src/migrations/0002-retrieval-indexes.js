/**
 * The two indexes `sequelize.sync` cannot express, moved out of boot-time
 * bootstrap code and into the migration record.
 *
 * Both were previously created by `ensureLexicalIndex` and
 * `ensureDocumentIndexes` on every start. Those calls remain as a safety net for
 * a database that has not been migrated, but this is where they belong.
 */

const LEXICAL_INDEX = 'document_chunks_fts_idx'
const DEDUPE_INDEX = 'documents_tenant_content_hash_completed_idx'

export const up = async ({ context: sequelize }) => {
  // Expression index rather than a stored tsvector column, so `sync({ alter: true })`
  // has no column it does not recognise and might decide to drop.
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS ${LEXICAL_INDEX}
       ON "document_chunks"
       USING GIN (to_tsvector('english', "text"))`
  )

  // Partial on purpose: a plain unique index would also refuse a retry of a
  // document whose first attempt FAILED.
  const [duplicates] = await sequelize.query(
    `SELECT COUNT(*) AS groups FROM (
       SELECT 1 FROM "documents"
        WHERE "status" = 'COMPLETED'
        GROUP BY "tenantId", "contentHash"
       HAVING COUNT(*) > 1
     ) d`
  )

  const groups = Number(duplicates?.[0]?.groups ?? 0)

  if (groups > 0) {
    // Failing here would block every later migration over a data condition that
    // predates this one and that the application already guards against.
    console.warn(
      `[MIGRATE] ${groups} duplicated (tenant, contentHash) group(s) exist; ` +
        `skipping ${DEDUPE_INDEX}. Remove the duplicates and re-run to add it.`
    )

    return
  }

  await sequelize.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${DEDUPE_INDEX}
       ON "documents" ("tenantId", "contentHash")
       WHERE "status" = 'COMPLETED'`
  )
}

export const down = async ({ context: sequelize }) => {
  await sequelize.query(`DROP INDEX IF EXISTS ${DEDUPE_INDEX}`)
  await sequelize.query(`DROP INDEX IF EXISTS ${LEXICAL_INDEX}`)
}
