import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkPages,
  dehyphenate,
  looksLikeHeading,
  normalizePageText,
  reflowItems,
  splitLongText,
  stripRepeatedLines
} from '../rag/chunker.js'

/** A pdf.js-shaped text item at a given position. */
const item = (str, x, y, { width = str.length * 5, hasEOL = false } = {}) => ({
  str,
  hasEOL,
  width,
  height: 10,
  transform: [1, 0, 0, 1, x, y]
})

describe('reflowItems', () => {
  it('joins adjacent runs without inserting a space', () => {
    const items = [item('Deletion', 0, 100, { width: 40 }), item('s', 40, 100)]

    assert.equal(reflowItems(items), 'Deletions')
  })

  it('inserts a space when the runs are separated by a gap', () => {
    const items = [item('audit', 0, 100, { width: 25 }), item('logs', 35, 100)]

    assert.equal(reflowItems(items), 'audit logs')
  })

  it('breaks a line on hasEOL', () => {
    const items = [item('first', 0, 100, { hasEOL: true }), item('second', 0, 88)]

    assert.equal(reflowItems(items), 'first\nsecond')
  })

  it('breaks a line on a vertical jump even without hasEOL', () => {
    const items = [item('first', 0, 100, { width: 25 }), item('second', 0, 84)]

    assert.equal(reflowItems(items), 'first\nsecond')
  })

  it('falls back to a space for rotated text it cannot measure', () => {
    const rotated = {
      str: 'sideways',
      hasEOL: false,
      transform: [0, 1, -1, 0, 0, 0]
    }

    assert.equal(reflowItems([item('label', 0, 100), rotated]), 'label sideways')
  })
})

describe('dehyphenate', () => {
  it('rejoins a word broken across a line', () => {
    assert.equal(dehyphenate('re-\ntained'), 'retained')
  })

  it('keeps the hyphen when the next line starts with a capital', () => {
    assert.equal(dehyphenate('Smith-\nJones'), 'Smith-\nJones')
  })

  it('keeps the hyphen before a number', () => {
    assert.equal(dehyphenate('COVID-\n19'), 'COVID-\n19')
  })
})

describe('normalizePageText', () => {
  // Escapes rather than pasted characters: all three are invisible in an editor.
  it('strips a soft hyphen', () => {
    assert.equal(normalizePageText('reten­tion'), 'retention')
  })

  it('strips a zero-width space', () => {
    assert.equal(normalizePageText('audit​logs'), 'auditlogs')
  })

  it('converts a non-breaking space to a plain one', () => {
    assert.equal(normalizePageText('90 days'), '90 days')
  })

  it('collapses runs of blank lines to one', () => {
    assert.equal(normalizePageText('a\n\n\n\nb'), 'a\n\nb')
  })
})

describe('stripRepeatedLines', () => {
  it('removes a header and footer repeated on every page', () => {
    const pages = [1, 2, 3, 4].map(
      (n) => `ACME CONFIDENTIAL\nbody of page ${n}\nPage ${n} of 4`
    )

    assert.deepEqual(
      stripRepeatedLines(pages),
      pages.map((_, i) => `body of page ${i + 1}`)
    )
  })

  it('leaves a line that only appears on a minority of pages', () => {
    const pages = [
      'HEADER\nfirst body\nfooter',
      'HEADER\nsecond body\nfooter',
      'HEADER\nthird body\nfooter',
      'ONE OFF NOTICE\nfourth body\nfooter'
    ]

    assert.ok(stripRepeatedLines(pages)[3].includes('ONE OFF NOTICE'))
  })

  it('leaves a two-page document alone', () => {
    const pages = ['HEADER\nbody one', 'HEADER\nbody two']

    assert.deepEqual(stripRepeatedLines(pages), pages)
  })

  it('does not remove a repeated line from the middle of a page', () => {
    const page = 'H\nline a\nline b\nsame middle sentence\nline c\nline d\nF'

    assert.ok(
      stripRepeatedLines([page, page, page])[0].includes('same middle sentence')
    )
  })
})

describe('looksLikeHeading', () => {
  it('accepts a numbered section title', () => {
    assert.equal(looksLikeHeading('1.2 Data Retention'), true)
  })

  it('accepts an all-caps title', () => {
    assert.equal(looksLikeHeading('DATA RETENTION'), true)
  })

  it('accepts a markdown heading', () => {
    assert.equal(looksLikeHeading('## Retention'), true)
  })

  it('rejects a sentence that merely starts with a capital letter', () => {
    assert.equal(looksLikeHeading('A quick note on retention'), false)
  })

  it('rejects a sentence that starts with a year', () => {
    assert.equal(looksLikeHeading('2026 was a strong year for the business'), false)
  })

  it('rejects a line ending in a full stop', () => {
    assert.equal(looksLikeHeading('1. Logs are retained.'), false)
  })

  it('rejects a long line', () => {
    assert.equal(looksLikeHeading(`1. ${'word '.repeat(30)}`), false)
  })
})

describe('splitLongText', () => {
  it('leaves text within budget untouched', () => {
    assert.deepEqual(splitLongText('short enough', 100), ['short enough'])
  })

  it('prefers a paragraph break over a sentence break', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}`

    assert.deepEqual(splitLongText(text, 80), ['a'.repeat(60), 'b'.repeat(60)])
  })

  it('keeps terminal punctuation with the sentence it ends', () => {
    const first = `${'First sentence padding. '.repeat(4)}Done.`
    const pieces = splitLongText(`${first} ${'Second half padding. '.repeat(4)}`, 110)

    assert.ok(pieces.every((piece) => /[.!?]$/.test(piece.trim())))
  })

  it('keeps every piece within budget', () => {
    const text = 'word '.repeat(400)

    assert.ok(splitLongText(text, 200).every((piece) => piece.length <= 200))
  })

  it('slices a run with no whitespace rather than exceeding the budget', () => {
    const pieces = splitLongText('x'.repeat(250), 100)

    assert.deepEqual(
      pieces.map((piece) => piece.length),
      [100, 100, 50]
    )
  })

  it('loses no characters other than the separators', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'

    assert.equal(splitLongText(text, 20).join(' '), text)
  })
})

/** Enough prose to force several chunks at a small target size. */
const paragraph = (label, sentences) =>
  Array.from(
    { length: sentences },
    (_, i) => `${label} sentence ${i} states a fact worth citing.`
  ).join(' ')

describe('chunkPages', () => {
  const settings = { targetChars: 400, overlapChars: 80 }

  it('returns nothing for pages with no text', () => {
    assert.deepEqual(chunkPages(['', '   \n\n  ']), [])
  })

  it('numbers chunks consecutively from zero', () => {
    const chunks = chunkPages(
      [paragraph('Alpha', 20), paragraph('Beta', 20)],
      settings
    )

    assert.ok(chunks.length > 2)
    assert.deepEqual(
      chunks.map((chunk) => chunk.chunkIndex),
      chunks.map((_, i) => i)
    )
  })

  it('records the page range each chunk spans', () => {
    const chunks = chunkPages(
      [paragraph('Alpha', 6), paragraph('Beta', 6)],
      { targetChars: 2000, overlapChars: 0 }
    )

    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].pageStart, 1)
    assert.equal(chunks[0].pageEnd, 2)
  })

  it('labels a chunk with the heading it sits under', () => {
    const chunks = chunkPages(
      [`1. Retention\n${paragraph('Retention', 4)}`],
      settings
    )

    assert.equal(chunks[0].heading, '1. Retention')
  })

  it('carries the previous chunk into the next as overlap', () => {
    const chunks = chunkPages([paragraph('Alpha', 30)], settings)

    assert.ok(chunks.length > 1)

    const tail = chunks[0].text.slice(-40)

    assert.ok(chunks[1].text.includes(tail.trim().split(' ').slice(-4).join(' ')))
  })

  it('starts overlap on a word boundary', () => {
    const chunks = chunkPages([paragraph('Alpha', 30)], settings)

    for (const chunk of chunks.slice(1)) {
      assert.ok(/^[A-Z]/.test(chunk.text) || /^\w/.test(chunk.text))
    }
  })

  it('keeps charCount in step with the text it describes', () => {
    for (const chunk of chunkPages([paragraph('Alpha', 30)], settings)) {
      assert.equal(chunk.charCount, chunk.text.length)
    }
  })

  it('does not emit a chunk under the merge floor', () => {
    const chunks = chunkPages(
      [`${paragraph('Alpha', 12)}\n\nOrphan.`],
      { targetChars: 400, overlapChars: 40, minChunkRatio: 0.4 }
    )

    const floor = 400 * 0.4

    assert.ok(chunks.every((chunk) => chunk.charCount >= floor))
  })

  it('respects the hard maximum even when merging', () => {
    const chunks = chunkPages([paragraph('Alpha', 40)], {
      targetChars: 300,
      overlapChars: 40,
      hardMaxChars: 400
    })

    assert.ok(chunks.every((chunk) => chunk.charCount <= 400))
  })
})
