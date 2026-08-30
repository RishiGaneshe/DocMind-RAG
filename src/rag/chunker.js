import { chunkingConfig } from '../config.js'

/**
 * Turns pdf.js text items back into lines.
 *
 * `getTextContent()` emits a run per font/style change, not per line, so joining
 * the runs with a space — the previous behaviour — inserted a space into every
 * word that happened to straddle a style boundary. The geometry is the reliable
 * signal: a vertical jump means a new line, a horizontal gap means a space, and
 * anything else means the runs were adjacent and belong to the same word.
 */
const isMeasurable = (item) =>
  Array.isArray(item.transform) &&
  item.transform.length === 6 &&
  item.transform[1] === 0 &&
  item.transform[2] === 0 &&
  typeof item.width === 'number'

const separatorBetween = (previous, item) => {
  // Rotated or unmeasured text: fall back to a space, which errs towards
  // splitting words rather than fusing two of them together.
  if (!isMeasurable(previous) || !isMeasurable(item)) return ' '

  const reference = previous.height || item.height || 10

  if (Math.abs(item.transform[5] - previous.transform[5]) > reference * 0.5) {
    return '\n'
  }

  const gap = item.transform[4] - (previous.transform[4] + previous.width)

  return gap > reference * 0.2 ? ' ' : ''
}

export const reflowItems = (items) => {
  let text = ''
  let previous = null

  for (const item of items) {
    if (typeof item.str !== 'string') continue

    if (previous && item.str && !/\s$/.test(text) && !/^\s/.test(item.str)) {
      text += separatorBetween(previous, item)
    }

    text += item.str

    if (item.hasEOL) text += '\n'

    previous = item
  }

  return text
}

// Spelled as escapes on purpose: every character below is invisible in an editor.
const HYPHENS = '\\u002d\\u2010\\u2011'
const INVISIBLE = new RegExp('[\\u00ad\\u200b-\\u200d\\u2060\\ufeff]', 'g')
const EXOTIC_SPACES = new RegExp(
  '[\\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000]',
  'g'
)
const DEHYPHENATE = new RegExp(`(\\p{Ll})[${HYPHENS}]\\n(\\p{Ll})`, 'gu')

/**
 * Rejoins words the PDF broke across a line. Restricted to a lowercase letter on
 * both sides so `COVID-\n19`, `Smith-\nJones` and `end-\nto-end` keep the hyphen
 * they were written with.
 */
export const dehyphenate = (text) => text.replace(DEHYPHENATE, '$1$2')

export const normalizePageText = (text) =>
  dehyphenate(
    text
      .replace(/\r\n?/g, '\n')
      // Soft hyphens and zero-width characters survive extraction and break
      // both lexical matching and the trigram comparison.
      .replace(INVISIBLE, '')
      .replace(EXOTIC_SPACES, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * Drops running headers and footers.
 *
 * Digits are masked before comparison so `Page 3 of 12` and `Page 4 of 12` count
 * as the same line, and only the first and last few lines of each page are
 * considered so a sentence that genuinely repeats in the body survives. Left in,
 * this boilerplate is a large source of near-duplicate chunks: every chunk from a
 * 40-page report otherwise carries the same footer.
 */
/**
 * How many lines at each end of a page count as header/footer territory.
 *
 * Capped so the two windows can never meet: on a three-line page the requested
 * three-line window would classify the body as an edge, and since digits are
 * masked before comparison, `body of page 1` and `body of page 2` would then look
 * like the same repeated line and the document would be stripped to nothing.
 */
const edgeWindow = (lineCount, edgeLines) =>
  Math.max(1, Math.min(edgeLines, Math.floor((lineCount - 1) / 2)))

export const stripRepeatedLines = (
  pages,
  { edgeLines = 3, minPages = 3, ratio = 0.6 } = {}
) => {
  if (pages.length < minPages) return pages

  const normalize = (line) =>
    line.trim().replace(/\s+/g, ' ').replace(/\d+/g, '#').toLowerCase()

  const counts = new Map()

  for (const page of pages) {
    const lines = page.split('\n')
    const window = edgeWindow(lines.length, edgeLines)

    const edges = new Set([
      ...lines.slice(0, window),
      ...lines.slice(-window)
    ])

    for (const line of edges) {
      const key = normalize(line)

      if (!key || key.length > 120) continue

      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const threshold = Math.max(minPages, Math.ceil(pages.length * ratio))

  const boilerplate = new Set(
    [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([key]) => key)
  )

  if (boilerplate.size === 0) return pages

  return pages.map((page) => {
    const lines = page.split('\n')
    const window = edgeWindow(lines.length, edgeLines)

    return lines
      .filter((line, i) => {
        const atEdge = i < window || i >= lines.length - window

        return !atEdge || !boilerplate.has(normalize(line))
      })
      .join('\n')
      .trim()
  })
}

const HEADING_MAX_CHARS = 120
const HEADING_MAX_WORDS = 12
const MARKDOWN_HEADING = /^#{1,6}\s+\S/
// `1.2 Retention` needs no trailing punctuation — the internal dots are signal
// enough — but a single leading token does, so `A quick note` and `2026 was
// a good year` are not mistaken for section titles.
const NUMBERED_HEADING =
  /^(?:\d+(?:\.\d+)+\.?|\d+[.)]|[A-Z][.)]|[IVXLC]{1,6}[.)])\s+\S/

/**
 * Recognises a section title so chunks can be labelled with the heading they sit
 * under. Deliberately conservative — a false positive silently mislabels every
 * chunk that follows, so a line needs to be short, unpunctuated at the end, and
 * either explicitly numbered or in caps.
 */
export const looksLikeHeading = (line) => {
  const trimmed = line.trim()

  if (!trimmed || trimmed.length > HEADING_MAX_CHARS) return false
  if (MARKDOWN_HEADING.test(trimmed)) return true
  if (/[.,;:!?]$/.test(trimmed)) return false
  if (trimmed.split(/\s+/).length > HEADING_MAX_WORDS) return false
  if (NUMBERED_HEADING.test(trimmed)) return true

  const letters = trimmed.replace(/[^\p{L}]/gu, '')

  return letters.length >= 3 && letters === letters.toUpperCase()
}

export const stripHeadingMarkers = (line) =>
  line.trim().replace(/^#{1,6}\s+/, '')

/**
 * Split points in descending order of how natural a break they make. The
 * splitter drops to the next level only when the current one leaves a piece over
 * budget, so a paragraph is preferred to a line, a line to a sentence, and a
 * sentence to a bare word gap. Lookbehind keeps terminal punctuation attached to
 * the sentence it ends.
 */
const SPLIT_LEVELS = [
  { pattern: /\n{2,}/, join: '\n\n' },
  { pattern: /\n/, join: '\n' },
  { pattern: /(?<=[.!?])\s+/, join: ' ' },
  { pattern: /(?<=[;:,])\s+/, join: ' ' },
  { pattern: /\s+/, join: ' ' }
]

export const splitLongText = (text, maxChars, level = 0) => {
  if (text.length <= maxChars) return [text]

  const rule = SPLIT_LEVELS[level]

  // Out of separators: slice hard rather than hand the embedder an input it
  // would reject. Only reachable for pathological runs with no whitespace.
  if (!rule) {
    const pieces = []

    for (let i = 0; i < text.length; i += maxChars) {
      pieces.push(text.slice(i, i + maxChars))
    }

    return pieces
  }

  const parts = text.split(rule.pattern).filter((part) => part.length > 0)

  if (parts.length < 2) return splitLongText(text, maxChars, level + 1)

  const pieces = []

  let buffer = ''

  for (const part of parts) {
    const candidate = buffer ? buffer + rule.join + part : part

    if (candidate.length <= maxChars) {
      buffer = candidate

      continue
    }

    if (buffer) {
      pieces.push(buffer)
      buffer = ''
    }

    if (part.length > maxChars) {
      pieces.push(...splitLongText(part, maxChars, level + 1))
    } else {
      buffer = part
    }
  }

  if (buffer) pieces.push(buffer)

  return pieces
}

/**
 * Flattens pages into paragraph-sized blocks, each tagged with the page it came
 * from and the heading in force at that point.
 *
 * Lines are grouped rather than the page split on blank lines, because plenty of
 * PDFs extract with no blank lines at all. A heading both closes the block before
 * it and is emitted as a block of its own, which is what puts the title at the
 * top of the chunk covering its section.
 */
const toBlocks = (pages) => {
  const blocks = []

  let heading = null

  pages.forEach((pageText, index) => {
    const page = index + 1

    let buffer = []

    const flush = () => {
      const text = buffer.join(' ').replace(/[ \t]+/g, ' ').trim()

      buffer = []

      if (text) blocks.push({ text, page, heading })
    }

    for (const rawLine of pageText.split('\n')) {
      const line = rawLine.trim()

      if (!line) {
        flush()

        continue
      }

      if (looksLikeHeading(line)) {
        flush()

        heading = stripHeadingMarkers(line)

        blocks.push({ text: heading, page, heading })

        continue
      }

      buffer.push(line)
    }

    flush()
  })

  return blocks
}

/**
 * The overlap carried into the next chunk, snapped to a sentence boundary where
 * one falls inside the window and to a word boundary otherwise. Overlap exists so
 * a fact split across a boundary is still answerable from one chunk; starting it
 * mid-word would defeat that.
 */
const overlapTail = (text, overlapChars) => {
  if (overlapChars <= 0 || text.length <= overlapChars) return ''

  const tail = text.slice(-overlapChars)
  const sentence = tail.search(/(?<=[.!?])\s+/)

  if (sentence !== -1 && tail.length - sentence >= overlapChars * 0.3) {
    return tail.slice(sentence).trim()
  }

  const space = tail.indexOf(' ')

  return space === -1 ? tail : tail.slice(space + 1).trim()
}

/**
 * Packs blocks into chunks of roughly `targetChars`, carrying `overlapChars` of
 * the previous chunk into the next.
 */
const packBlocks = (blocks, settings) => {
  const chunks = []

  let current = null

  const close = () => {
    if (!current) return

    const text = current.parts.join('\n').trim()

    if (text) {
      chunks.push({
        text,
        pageStart: current.pageStart,
        pageEnd: current.pageEnd,
        heading: current.heading,
        seedChars: current.seedChars
      })
    }

    current = null
  }

  const open = (page, heading, seed) => {
    current = {
      parts: seed ? [seed] : [],
      length: seed ? seed.length + 1 : 0,
      seedChars: seed ? seed.length : 0,
      pageStart: page,
      pageEnd: page,
      heading
    }
  }

  for (const block of blocks) {
    for (const piece of splitLongText(block.text, settings.targetChars)) {
      if (current && current.length + piece.length > settings.targetChars) {
        const previousEnd = current.pageEnd
        const tail = overlapTail(current.parts.join('\n'), settings.overlapChars)

        close()

        // The overlap is text from the page that just ended, so the new chunk
        // starts there rather than on the page of the block opening it.
        if (tail) open(previousEnd, block.heading, tail)
      }

      if (!current) open(block.page, block.heading, null)

      current.parts.push(piece)
      current.length += piece.length + 1
      current.pageEnd = block.page
      current.heading ??= block.heading
    }
  }

  close()

  return chunks
}

/**
 * Folds undersized chunks into the chunk before them.
 *
 * A 60-character chunk holding one orphaned sentence is close to useless: it
 * embeds to a vector dominated by whatever few words it has, and if it wins a
 * slot it displaces a chunk that could have answered the question. The seed
 * overlap is sliced off first so merging does not duplicate it.
 */
const mergeShortChunks = (chunks, settings) => {
  const floor = settings.targetChars * settings.minChunkRatio
  const merged = []

  for (const chunk of chunks) {
    const previous = merged[merged.length - 1]

    const body =
      chunk.seedChars > 0 ? chunk.text.slice(chunk.seedChars).trim() : chunk.text

    const canMerge =
      previous &&
      chunk.text.length < floor &&
      previous.text.length + body.length + 1 <= settings.hardMaxChars

    if (!canMerge) {
      merged.push(chunk)

      continue
    }

    if (body) previous.text = `${previous.text}\n${body}`

    previous.pageEnd = Math.max(previous.pageEnd, chunk.pageEnd)
    previous.heading ??= chunk.heading
  }

  return merged
}

const resolveSettings = (options) => ({
  targetChars: options.targetChars ?? chunkingConfig.targetChars,
  overlapChars: options.overlapChars ?? chunkingConfig.overlapChars,
  minChunkRatio: options.minChunkRatio ?? chunkingConfig.minChunkRatio,
  hardMaxChars: options.hardMaxChars ?? chunkingConfig.hardMaxChars
})

/**
 * Turns per-page text into the chunk rows the rest of the pipeline stores.
 *
 * Chunks carry the page range and the heading they sit under so an answer can
 * cite `report.pdf › page 4 › Revenue` instead of `chunk 37`, which is the
 * difference between a citation a reader can check and one they have to trust.
 */
export const chunkPages = (rawPages, options = {}) => {
  const settings = resolveSettings(options)

  const pages = stripRepeatedLines(rawPages.map(normalizePageText))
  const blocks = toBlocks(pages)

  if (blocks.length === 0) return []

  return mergeShortChunks(packBlocks(blocks, settings), settings).map(
    (chunk, index) => ({
      chunkIndex: index,
      text: chunk.text,
      charCount: chunk.text.length,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      heading: chunk.heading
    })
  )
}

export const CHUNKING_VERSION = chunkingConfig.version
