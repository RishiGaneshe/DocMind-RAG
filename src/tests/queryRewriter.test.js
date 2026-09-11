import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  needsRewrite,
  sanitizeRewrite,
  rewriteQuery
} from '../rag/queryRewriter.js'

const history = [
  { role: 'user', content: 'How long are audit logs retained?' },
  { role: 'assistant', content: 'Audit logs are retained for 90 days [2].' }
]

describe('needsRewrite', () => {
  test('is true for any non-empty string query, with or without history', () => {
    assert.equal(needsRewrite('what about it?', []), true)
    assert.equal(needsRewrite('what about it?', undefined), true)
    assert.equal(needsRewrite('what about it?', null), true)
    assert.equal(needsRewrite('mera payslip kyu nahi dikh raha', history), true)
    assert.equal(needsRewrite('debug logs?', history), true)
  })

  test('is false for non-string, empty, or whitespace queries', () => {
    assert.equal(needsRewrite('   ', history), false)
    assert.equal(needsRewrite('', history), false)
    assert.equal(needsRewrite(null, history), false)
    assert.equal(needsRewrite(undefined, history), false)
    assert.equal(needsRewrite(123, history), false)
    assert.equal(needsRewrite({}, history), false)
  })
})

describe('sanitizeRewrite', () => {
  const original = 'mera payslip kyu nahi dikh raha?'

  test('returns the original for a non-string', () => {
    assert.equal(sanitizeRewrite(null, original), original)
    assert.equal(sanitizeRewrite(undefined, original), original)
    assert.equal(sanitizeRewrite(42, original), original)
    assert.equal(sanitizeRewrite('test', null), 'test')
    assert.equal(sanitizeRewrite('test', undefined), 'test')
  })

  test('returns the original for empty output', () => {
    assert.equal(sanitizeRewrite('', original), original)
    assert.equal(sanitizeRewrite('\n  \n', original), original)
  })

  test('keeps the substantive query and strips preambles', () => {
    const raw = 'Here is the search-optimized query:\nWhy is my monthly payslip not visible or downloadable?'

    assert.equal(
      sanitizeRewrite(raw, original),
      'Why is my monthly payslip not visible or downloadable?'
    )
  })

  test('strips plain and bold label prefixes', () => {
    assert.equal(
      sanitizeRewrite('Rewrite: What is the debug logs retention?', original),
      'What is the debug logs retention?'
    )
    assert.equal(
      sanitizeRewrite('**Search Query:** Why is my payslip not visible?', original),
      'Why is my payslip not visible?'
    )
    assert.equal(
      sanitizeRewrite('Search-Optimized Query: why is payslip not downloading', original),
      'why is payslip not downloading'
    )
  })

  test('handles markdown code block wrappers', () => {
    assert.equal(
      sanitizeRewrite('```text\nWhy is my payslip not visible?\n```', original),
      'Why is my payslip not visible?'
    )
  })

  test('strips surrounding quotes and emphasis', () => {
    assert.equal(
      sanitizeRewrite('"How long are debug logs kept?"', original),
      'How long are debug logs kept?'
    )
    assert.equal(
      sanitizeRewrite('**debug logs retention**', original),
      'debug logs retention'
    )
  })

  test('rejects a rewrite that grew into an essay', () => {
    const essay = 'a'.repeat(600)
    assert.equal(sanitizeRewrite(essay, original), original)
  })

  test('accepts clean multilingual translation without requiring shared words', () => {
    assert.equal(
      sanitizeRewrite('Why is monthly payslip not visible for employee?', 'mera salary slip kyu nahi dikh raha'),
      'Why is monthly payslip not visible for employee?'
    )
    assert.equal(
      sanitizeRewrite('How to apply for annual leave?', 'chutti kaise le'),
      'How to apply for annual leave?'
    )
  })
})

describe('rewriteQuery', () => {
  test('short-circuits without an LLM call when query is empty or invalid', async () => {
    assert.deepEqual(await rewriteQuery('   ', history), {
      query: '   ',
      rewritten: false
    })

    assert.deepEqual(await rewriteQuery('', undefined), {
      query: '',
      rewritten: false
    })

    assert.deepEqual(await rewriteQuery(null, undefined), {
      query: null,
      rewritten: false
    })
  })
})
