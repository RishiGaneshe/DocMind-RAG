import crypto from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'

import { chunkPages, reflowItems, CHUNKING_VERSION } from '../rag/chunker.js'
import { chunkingConfig } from '../config.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const STANDARD_FONT_DATA_URL = path.join(
  __dirname, '..', '..', 'node_modules', 'pdfjs-dist', 'standard_fonts/'
)

// Breadcrumbs are stored in a bounded column and shown in the UI, so a runaway
// heading is trimmed rather than allowed to fail the insert.
const MAX_BREADCRUMB_CHARS = 700

/**
 * Extracts one string per page.
 *
 * Per-page rather than one concatenated blob: a chunk that cannot say which page
 * it came from cannot be cited, and page boundaries are also the only reliable
 * place to detect a running header.
 */
const extractPages = async (fileBuffer) => {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(fileBuffer),
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useSystemFonts: true
  })

  const pdf = await loadingTask.promise

  try {
    const pages = []

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber)

      try {
        const { items } = await page.getTextContent()

        pages.push(reflowItems(items))
      } finally {
        page.cleanup()
      }
    }

    return { pages, numPages: pdf.numPages }
  } finally {
    // pdf.js holds the parsed document and its font data until told otherwise,
    // which on a busy upload path is a slow memory leak.
    await pdf.destroy()
  }
}

/**
 * Content hash of the raw file, computed without parsing it.
 *
 * Exported separately so the upload route can look for an existing document
 * with the same hash before spending a PDF parse and an embedding run on a
 * file it already has.
 */
export const hashBuffer = (fileBuffer) =>
  crypto.createHash('sha256').update(fileBuffer).digest('hex')

const buildBreadcrumb = (filename, chunk) => {
  const pages =
    chunk.pageEnd && chunk.pageEnd !== chunk.pageStart
      ? `pages ${chunk.pageStart}-${chunk.pageEnd}`
      : `page ${chunk.pageStart}`

  const parts = [filename, pages, chunk.heading].filter(Boolean)

  return parts.join(' › ').slice(0, MAX_BREADCRUMB_CHARS)
}

export const processDocument = async (fileBuffer, filename) => {
  const { pages, numPages } = await extractPages(fileBuffer)

  const contentHash = hashBuffer(fileBuffer)

  const chunks = chunkPages(pages).map((chunk) => ({
    ...chunk,
    breadcrumb: buildBreadcrumb(filename, chunk)
  }))

  return {
    filename,
    contentHash,
    numPages,
    chunks,
    metadata: {
      chunkingVersion: CHUNKING_VERSION,
      targetChars: chunkingConfig.targetChars,
      overlapChars: chunkingConfig.overlapChars,
      pagesWithText: pages.filter((page) => page.trim()).length
    }
  }
}
