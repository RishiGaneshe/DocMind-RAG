import { QueryTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import { DocumentChunk } from '../models/DocumentChunk.js'

const LEXICAL_CONFIG = 'english'
const LEXICAL_INDEX_NAME = 'document_chunks_fts_idx'

/**
 * Creates the GIN index backing lexical search. An expression index is used
 * rather than a stored tsvector column so that `sequelize.sync({ alter: true })`
 * has no column it does not know about and might decide to drop.
 *
 * Safe to call on every boot.
 */
export const ensureLexicalIndex = async () => {
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS ${LEXICAL_INDEX_NAME}
       ON "document_chunks"
       USING GIN (to_tsvector('${LEXICAL_CONFIG}', "text"))`
  )

  console.log(`Lexical index ready: ${LEXICAL_INDEX_NAME}`)
}

/**
 * Writes chunk rows, overwriting any row with the same id. Re-uploading the
 * same document therefore refreshes its text in place instead of failing on a
 * primary key collision.
 */
export const saveChunks = async (rows) => {
  if (rows.length === 0) return 0

  await DocumentChunk.bulkCreate(rows, {
    updateOnDuplicate: [
      'tenantId',
      'documentId',
      'chunkIndex',
      'text',
      'charCount',
      'pageStart',
      'pageEnd',
      'heading',
      'breadcrumb',
      'chunkingVersion',
      'updatedAt'
    ]
  })

  return rows.length
}

/**
 * Loads chunk text for ids returned by an ANN query. `tenantId` is part of the
 * predicate rather than assumed from the id, so a forged or stale id from
 * another namespace cannot hydrate into someone else's context.
 *
 * Returns a Map keyed by chunk id. Ids with no row are simply absent, which is
 * the expected case for vectors written before the chunk store existed and not
 * yet backfilled.
 */
export const hydrateChunks = async (tenantId, ids) => {
  if (ids.length === 0) return new Map()

  const rows = await DocumentChunk.findAll({
    where: { tenantId, id: ids },
    attributes: [
      'id',
      'documentId',
      'chunkIndex',
      'text',
      'pageStart',
      'pageEnd',
      'heading',
      'breadcrumb',
      'chunkingVersion'
    ],
    raw: true
  })

  return new Map(rows.map((row) => [row.id, row]))
}

/**
 * Lexical half of hybrid retrieval. `websearch_to_tsquery` is used instead of
 * `plainto_tsquery` because it accepts quoted phrases and `-exclusions` from
 * user input and never raises a syntax error on odd punctuation.
 *
 * Returns `[{ id, rank }]` best first.
 */
export const lexicalSearch = async (
  tenantId,
  query,
  limit,
  { documentIds } = {}
) => {
  const hasDocumentFilter = Array.isArray(documentIds) && documentIds.length > 0

  const sql = `
    WITH q AS (
      SELECT websearch_to_tsquery('${LEXICAL_CONFIG}', :query) AS tsq
    )
    SELECT c."id",
           ts_rank_cd(to_tsvector('${LEXICAL_CONFIG}', c."text"), q.tsq) AS rank
      FROM "document_chunks" c, q
     WHERE c."tenantId" = :tenantId
       AND to_tsvector('${LEXICAL_CONFIG}', c."text") @@ q.tsq
       ${hasDocumentFilter ? 'AND c."documentId" IN (:documentIds)' : ''}
     ORDER BY rank DESC
     LIMIT :limit`

  const rows = await sequelize.query(sql, {
    type: QueryTypes.SELECT,
    replacements: {
      query,
      tenantId,
      limit,
      ...(hasDocumentFilter ? { documentIds } : {})
    }
  })

  return rows.map((row) => ({ id: row.id, rank: Number(row.rank) }))
}

export const deleteChunksForDocument = async (tenantId, documentId) =>
  await DocumentChunk.destroy({ where: { tenantId, documentId } })

export const countChunks = async (tenantId) =>
  await DocumentChunk.count({ where: { tenantId } })

/**
 * Whether the chunk store holds anything for this tenant. Retrieval uses this
 * to decide between hydrating from Postgres and falling back to Pinecone
 * metadata, so a tenant whose vectors predate the backfill still gets answers.
 */
export const hasChunks = async (tenantId) => {
  const count = await DocumentChunk.count({ where: { tenantId }, limit: 1 })

  return count > 0
}

export const buildChunkId = (documentId, chunkIndex) =>
  `${documentId}-chunk-${chunkIndex}`
