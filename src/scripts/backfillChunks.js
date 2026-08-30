/**
 * Copies chunk text out of Pinecone metadata into the `document_chunks` table.
 *
 * Nothing is re-embedded and no vector is modified: this reads metadata that is
 * already stored and writes it to Postgres, which is what lets the lexical
 * retrieval lane and local hydration cover documents uploaded before the chunk
 * store existed.
 *
 * Idempotent — rows already present are skipped, so it is safe to re-run after
 * an interruption.
 *
 *   node src/scripts/backfillChunks.js [--tenant <uuid>] [--dry-run]
 */
import 'dotenv/config'

import { sequelize } from '../services/db.js'
import { Tenant } from '../models/Tenant.js'
import { Document } from '../models/Document.js'
import { DocumentChunk } from '../models/DocumentChunk.js'
import { initPinecone, listVectorIds, fetchVectorMetadata } from '../rag/vectorStore.js'
import { saveChunks } from '../rag/chunkStore.js'

// Pinecone caps a fetch at 100 ids.
const FETCH_BATCH_SIZE = 100
const LIST_PAGE_SIZE = 100

// Rows written by this script came from the original 500-word fixed-window
// splitter. Tagging them keeps a mixed corpus legible.
const LEGACY_CHUNKING_VERSION = 1

const parseArgs = (argv) => {
  const tenantIndex = argv.indexOf('--tenant')

  return {
    tenantId: tenantIndex === -1 ? null : argv[tenantIndex + 1],
    dryRun: argv.includes('--dry-run')
  }
}

const listAllIds = async (tenantId) => {
  const ids = []

  let paginationToken

  do {
    const page = await listVectorIds(tenantId, {
      paginationToken,
      limit: LIST_PAGE_SIZE
    })

    ids.push(...page.ids)
    paginationToken = page.next
  } while (paginationToken)

  return ids
}

const batch = (items, size) => {
  const batches = []

  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size))
  }

  return batches
}

const backfillTenant = async (tenant, { dryRun }) => {
  const ids = await listAllIds(tenant.id)

  if (ids.length === 0) {
    console.log(`  no vectors in namespace`)

    return { written: 0, skipped: 0, orphaned: 0, textless: 0 }
  }

  const existing = await DocumentChunk.findAll({
    where: { tenantId: tenant.id, id: ids },
    attributes: ['id'],
    raw: true
  })

  const present = new Set(existing.map((row) => row.id))
  const pending = ids.filter((id) => !present.has(id))

  console.log(`  ${ids.length} vectors, ${present.size} already backfilled`)

  if (pending.length === 0) return { written: 0, skipped: present.size, orphaned: 0, textless: 0 }

  // A chunk row references its document, so a vector whose document has been
  // deleted from Postgres cannot be written and is reported instead.
  const documents = await Document.findAll({
    where: { tenantId: tenant.id },
    attributes: ['id'],
    raw: true
  })

  const knownDocuments = new Set(documents.map((row) => row.id))

  let written = 0
  let orphaned = 0
  let textless = 0

  for (const idBatch of batch(pending, FETCH_BATCH_SIZE)) {
    const records = await fetchVectorMetadata(tenant.id, idBatch)

    const rows = []

    for (const id of idBatch) {
      const metadata = records[id]?.metadata

      if (!metadata?.text) {
        textless += 1

        continue
      }

      if (!knownDocuments.has(metadata.documentId)) {
        orphaned += 1

        continue
      }

      rows.push({
        id,
        tenantId: tenant.id,
        documentId: metadata.documentId,
        chunkIndex: Number(metadata.chunkIndex ?? 0),
        text: metadata.text,
        charCount: metadata.text.length,
        pageStart: metadata.pageStart ? Number(metadata.pageStart) : null,
        pageEnd: metadata.pageEnd ? Number(metadata.pageEnd) : null,
        heading: null,
        breadcrumb: null,
        chunkingVersion: Number(metadata.chunkingVersion ?? LEGACY_CHUNKING_VERSION)
      })
    }

    if (!dryRun && rows.length > 0) await saveChunks(rows)

    written += rows.length

    process.stdout.write(`\r  written ${written}/${pending.length}`)
  }

  process.stdout.write('\n')

  return { written, skipped: present.size, orphaned, textless }
}

const main = async () => {
  const { tenantId, dryRun } = parseArgs(process.argv.slice(2))

  if (dryRun) console.log('Dry run: nothing will be written\n')

  await sequelize.authenticate()
  await initPinecone()

  const tenants = tenantId
    ? await Tenant.findAll({ where: { id: tenantId } })
    : await Tenant.findAll()

  if (tenants.length === 0) {
    console.error(tenantId ? `Tenant ${tenantId} not found` : 'No tenants found')

    process.exitCode = 1

    return
  }

  const totals = { written: 0, skipped: 0, orphaned: 0, textless: 0 }

  for (const tenant of tenants) {
    console.log(`Tenant ${tenant.id} (${tenant.name ?? 'unnamed'})`)

    try {
      const result = await backfillTenant(tenant, { dryRun })

      for (const key of Object.keys(totals)) totals[key] += result[key]
    } catch (error) {
      console.error(`  failed: ${error.message}`)

      process.exitCode = 1
    }
  }

  console.log(
    `\nDone. ${totals.written} rows written, ${totals.skipped} already present, ` +
      `${totals.orphaned} skipped as orphaned, ${totals.textless} without text.`
  )
}

try {
  await main()
} finally {
  await sequelize.close()
}
