import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createAnswerFilter } from '../rag/answerStream.js'
import {
  validateCitations,
  isNoAnswer,
  stripReasoning
} from '../services/llmService.js'

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

describe('createAnswerFilter reasoning suppression', () => {
  it('releases an ordinary answer on the first delta', () => {
    const filter = createAnswerFilter(3)

    assert.equal(
      filter.push('Employees are entitled to 18 days of annual leave.'),
      'Employees are entitled to 18 days of annual leave.'
    )
    assert.equal(filter.suppressedReasoning, false)
  })

  it('drops a thinking preamble and keeps the answer', () => {
    const { out, filter } = run([
      "Here's a thinking process:\n\n",
      '1. **Analyze User Input:** The user is asking about leave policies, ',
      'so I need to check the notes.\n\n',
      'Employees are entitled to 18 days of annual leave.'
    ])

    assert.equal(out, 'Employees are entitled to 18 days of annual leave.')
    assert.equal(filter.suppressedReasoning, true)
  })

  it('drops a <think> block split across deltas and streams the rest', () => {
    const { out, filter } = run([
      '<th',
      'ink>The user wants the leave policy. Let me check.',
      '</think>',
      '\n\nEmployees get 18 days.'
    ])

    assert.equal(out, 'Employees get 18 days.')
    assert.equal(filter.suppressedReasoning, true)
  })

  it('resumes streaming at an explicit answer marker', () => {
    const filter = createAnswerFilter(3)

    assert.equal(filter.push("Here's a thinking process:\n1. Check notes."), '')
    assert.equal(filter.push('\n\n**Answer:** '), '')
    assert.equal(filter.push('Employees get 18 days.'), 'Employees get 18 days.')
    assert.equal(filter.flush(), '')
  })

  it('still catches the refusal sentinel behind a think block', () => {
    const { out, filter } = run(['<think>Nothing relevant.</think>', 'NOT_IN_CONTEXT'])

    assert.equal(out, '')
    assert.equal(filter.refused, true)
  })

  it('keeps a one-paragraph reply that only looks like deliberation', () => {
    const text = 'The user is asking party is notified within 24 hours.'

    assert.equal(run([text]).out, text)
  })

  it('does not hold back a numbered answer for long', () => {
    const { out } = run(['1. Submit the form.\n2. Await approval.'])

    assert.equal(out, '1. Submit the form.\n2. Await approval.')
  })

  it('resumes streaming once a numbered plan gives way to the answer', () => {
    const answer =
      'Employees receive 18 days of annual leave per calendar year.'

    const leaked = [
      "Here's a thinking process:",
      '',
      '1. **Analyze User Input:** the user is asking about leave.',
      '',
      '2. **Scan the notes:** note [3] covers annual leave.',
      '',
      '3. **Draft the answer:** combine both notes.',
      '',
      answer
    ].join('\n')

    const filter = createAnswerFilter(6)

    let out = ''
    let streamedBeforeFlush = false

    // Six-character deltas, roughly the size of real tokens.
    for (const delta of leaked.match(/.{1,6}/gs)) {
      const emitted = filter.push(delta)

      if (emitted) streamedBeforeFlush = true

      out += emitted
    }

    out += filter.flush()

    assert.equal(out, answer)
    assert.equal(streamedBeforeFlush, true)
    assert.equal(filter.suppressedReasoning, true)
  })
})

describe('stripReasoning', () => {
  it('leaves an ordinary answer untouched', () => {
    const text = 'Audit logs are retained for 90 days.'

    assert.equal(stripReasoning(text), text)
  })

  it('removes a closed think block', () => {
    assert.equal(
      stripReasoning('<think>Let me check the notes.</think>\n\n18 days.'),
      '18 days.'
    )
  })

  it('removes deliberation that ends at an unopened closing tag', () => {
    assert.equal(
      stripReasoning('The user is asking about leave.</think>18 days.'),
      '18 days.'
    )
  })

  it('cuts at the last answer marker', () => {
    const raw = [
      "Here's a thinking process:",
      '1. The user wants the leave policy.',
      '',
      'Final answer: Employees get 18 days.'
    ].join('\n')

    assert.equal(stripReasoning(raw), 'Employees get 18 days.')
  })

  it('drops leading deliberation when nothing marks the answer', () => {
    const raw = [
      "Here's a thinking process:",
      '',
      '1. **Analyze User Input:** the user is asking about leave.',
      '- I need to combine the notes.',
      '',
      'Employees are entitled to 18 days of annual leave.'
    ].join('\n')

    assert.equal(
      stripReasoning(raw),
      'Employees are entitled to 18 days of annual leave.'
    )
  })

  it('follows a numbered plan past the step that names no meta term', () => {
    const raw = [
      "Here's a thinking process:",
      '',
      '1. **Analyze User Input:** the user is asking about leave.',
      '',
      '2. **Scan:** annual leave is 18 days.',
      '',
      '3. **Draft:** combine into one reply.',
      '',
      'Employees receive 18 days of annual leave.'
    ].join('\n')

    assert.equal(stripReasoning(raw), 'Employees receive 18 days of annual leave.')
  })

  it('keeps the closing paragraph rather than returning nothing', () => {
    const raw = "Here's a thinking process:\n\nLet me think about it."

    assert.equal(stripReasoning(raw), 'Let me think about it.')
  })

  it('returns an empty string for a reply that is only a think block', () => {
    assert.equal(stripReasoning('<think>All internal.</think>'), '')
  })
})
