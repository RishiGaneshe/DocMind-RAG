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
  test('is false without history, whatever the query looks like', () => {
    assert.equal(needsRewrite('what about it?', []), false)
    assert.equal(needsRewrite('what about it?', undefined), false)
    assert.equal(needsRewrite('what about it?', null), false)
  })

  test('is false for a long self-contained question', () => {
    assert.equal(
      needsRewrite('What is the retention period for debug logs?', history),
      false
    )
  })

  test('catches a follow-up opener', () => {
    assert.equal(needsRewrite('And the deletion schedule?', history), true)
    assert.equal(needsRewrite('what about debug logs', history), true)
  })

  test('catches a back-reference', () => {
    assert.equal(
      needsRewrite('Does that apply to the EU region as well?', history),
      true
    )
  })

  test('catches a very short query', () => {
    assert.equal(needsRewrite('debug logs?', history), true)
  })

  test('does not fire on "there", which starts standalone questions', () => {
    assert.equal(
      needsRewrite('Is there a documented retention policy for backups?', history),
      false
    )
  })

  test('is false for an empty or whitespace query', () => {
    assert.equal(needsRewrite('   ', history), false)
    assert.equal(needsRewrite('', history), false)
  })
})

describe('sanitizeRewrite', () => {
  const original = 'what about debug logs?'

  test('returns the original for a non-string', () => {
    assert.equal(sanitizeRewrite(null, original), original)
    assert.equal(sanitizeRewrite(undefined, original), original)
    assert.equal(sanitizeRewrite(42, original), original)
  })

  test('returns the original for empty output', () => {
    assert.equal(sanitizeRewrite('', original), original)
    assert.equal(sanitizeRewrite('\n  \n', original), original)
  })

  test('keeps only the first non-empty line', () => {
    const raw = '\nWhat is the retention period for debug logs?\nHope that helps!'

    assert.equal(
      sanitizeRewrite(raw, original),
      'What is the retention period for debug logs?'
    )
  })

  test('strips a label prefix', () => {
    assert.equal(
      sanitizeRewrite('Rewrite: What is the debug logs retention?', original),
      'What is the debug logs retention?'
    )
    assert.equal(
      sanitizeRewrite('Standalone question: debug logs retention period', original),
      'debug logs retention period'
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

  test('rejects a rewrite that grew into prose', () => {
    const essay = `Debug logs, like audit logs, are subject to a retention policy that
      is typically shorter, and in most systems this is configured somewhere between
      seven and thirty days depending on storage budgets and compliance posture`.replace(
      /\s+/g,
      ' '
    )

    assert.equal(sanitizeRewrite(essay, original), original)
  })

  test('rejects a rewrite sharing no significant word with the original', () => {
    assert.equal(
      sanitizeRewrite('The retention period is 90 days.', 'what about firewall rules'),
      'what about firewall rules'
    )
  })

  test('accepts a rewrite that keeps a significant word', () => {
    assert.equal(
      sanitizeRewrite('What is the retention period for debug logs?', original),
      'What is the retention period for debug logs?'
    )
  })

  test('accepts a valid pronoun resolution when original consists of common pronouns/stopwords', () => {
    assert.equal(
      sanitizeRewrite('Can administrators delete user accounts?', 'can they do that?'),
      'Can administrators delete user accounts?'
    )
  })
})

describe('rewriteQuery', () => {
  test('short-circuits without an LLM call when the gate is closed', async () => {
    const query = 'What is the retention period for debug logs?'

    assert.deepEqual(await rewriteQuery(query, history), {
      query,
      rewritten: false
    })
  })

  test('short-circuits when there is no history at all', async () => {
    const query = 'what about it'

    assert.deepEqual(await rewriteQuery(query, undefined), {
      query,
      rewritten: false
    })
  })
})
