import { QueryTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import { DocumentChunk } from '../models/DocumentChunk.js'

const LEXICAL_CONFIG = 'english'
const LEXICAL_INDEX_NAME = 'document_chunks_fts_idx'

export const ensureLexicalIndex = async () => {
  await sequelize.query(
    `CREATE INDEX IF NOT EXISTS ${LEXICAL_INDEX_NAME}
       ON "document_chunks"
       USING GIN (to_tsvector('${LEXICAL_CONFIG}', "text"))`
  )

  console.log(`Lexical index ready: ${LEXICAL_INDEX_NAME}`)
}

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

export const deleteChunksForDocument = async (tenantId, documentId, options = {}) =>
  await DocumentChunk.destroy({ where: { tenantId, documentId }, ...options })

export const countChunks = async (tenantId) =>
  await DocumentChunk.count({ where: { tenantId } })

export const hasChunks = async (tenantId) => {
  const count = await DocumentChunk.count({ where: { tenantId }, limit: 1 })

  return count > 0
}

export const buildChunkId = (documentId, chunkIndex) =>
  `${documentId}-chunk-${chunkIndex}`
