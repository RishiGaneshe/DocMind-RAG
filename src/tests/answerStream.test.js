import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnswerFilter } from '../rag/answerStream.js'
import { validateCitations, isNoAnswer } from '../services/llmService.js'

/** Feeds deltas through a filter and returns everything it emitted. */
const run = (deltas, sourceCount = 3) => {
  const filter = createAnswerFilter(sourceCount)

  let out = ''

  for (const delta of deltas) out += filter.push(delta)

  out += filter.flush()

  return { out, filter }
}

describe('createAnswerFilter', () => {
  it('passes an ordinary answer through unchanged', () => {
    const text = 'Audit logs are retained for 90 days.'

    assert.equal(run([text]).out, text)
  })

  it('strips in-range citation markers from the user-facing stream', () => {
    const { out, filter } = run(['Audit logs are retained for 90 days [2].'])

    assert.equal(out, 'Audit logs are retained for 90 days.')
    assert.equal(filter.droppedCitations, 0)
  })

  it('reassembles an answer split across many deltas', () => {
    const text = 'Deletion runs nightly at 02:00 UTC across all regions.'

    assert.equal(run([...text]).out, text)
  })

  it('withholds the refusal sentinel and reports the refusal', () => {
    const { out, filter } = run(['NOT_IN_CONTEXT'])

    assert.equal(out, '')
    assert.equal(filter.refused, true)
  })

  it('recognises the sentinel wrapped in markdown emphasis', () => {
    const { out, filter } = run(['**NOT_IN', '_CONTEXT**'])

    assert.equal(out, '')
    assert.equal(filter.refused, true)
  })

  it('does not mistake an answer starting with "not" for a refusal', () => {
    const text = 'Not all regions run the nightly job.'
    const { out, filter } = run([text])

    assert.equal(filter.refused, false)
    assert.equal(out, text)
  })

  it('strips a citation marker split across two deltas', () => {
    const { out, filter } = run(['Retention is 90 days [', '2] per policy.'])

    assert.equal(out, 'Retention is 90 days per policy.')
    assert.equal(filter.droppedCitations, 0)
  })

  it('drops a citation pointing past the supplied sources', () => {
    const { out, filter } = run(['Retention is 90 days [9].'], 3)

    assert.equal(out, 'Retention is 90 days.')
    assert.equal(filter.droppedCitations, 1)
  })

  it('drops an out-of-range citation even when it arrives split', () => {
    const { out, filter } = run(['Revenue rose [', '14] last year.'], 6)

    assert.equal(out, 'Revenue rose last year.')
    assert.equal(filter.droppedCitations, 1)
  })

  it('emits a trailing unterminated bracket rather than swallowing it', () => {
    assert.equal(run(['See figure [']).out, 'See figure [')
  })
})

describe('validateCitations', () => {
  it('strips in-range markers and reports which were used', () => {
    const result = validateCitations('Logs last 90 days [2][3].', 3)

    assert.equal(result.answer, 'Logs last 90 days.')
    assert.deepEqual(result.citedSources, [2, 3])
    assert.equal(result.droppedCitations, 0)
  })

  it('strips markers past the supplied source count', () => {
    const result = validateCitations('Revenue rose [1] and fell [7].', 3)

    assert.equal(result.droppedCitations, 1)
    assert.deepEqual(result.citedSources, [1])
    assert.equal(result.answer, 'Revenue rose and fell.')
    assert.ok(!result.answer.includes('[7]'))
    assert.ok(!result.answer.includes('[1]'))
  })

  it('leaves the answer byte-identical when there are no markers', () => {
    const text = '  Spacing   and punctuation preserved.  '

    assert.equal(validateCitations(text, 2).answer, text)
  })

  it('rejects a zero citation as out of range', () => {
    assert.equal(validateCitations('Claim [0].', 3).droppedCitations, 1)
  })
})

describe('isNoAnswer', () => {
  it('matches the bare sentinel', () => {
    assert.equal(isNoAnswer('NOT_IN_CONTEXT'), true)
  })

  it('matches the sentinel with trailing punctuation', () => {
    assert.equal(isNoAnswer('NOT_IN_CONTEXT.'), true)
  })

  it('does not match a normal answer that mentions context', () => {
    assert.equal(isNoAnswer('The context window is 32k tokens [1].'), false)
  })

  it('does not match an empty completion', () => {
    assert.equal(isNoAnswer(''), false)
  })
})
