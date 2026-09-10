// Create retrieval and deduplication indexes
const LEXICAL_INDEX = 'document_chunks_fts_idx'
const DEDUPE_INDEX = 'documents_tenant_content_hash_completed_idx'

export const up = async ({ context: sequelize }) => {
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS ${LEXICAL_INDEX}
       ON "document_chunks"
       USING GIN (to_tsvector('english', "text"))`
  )

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
