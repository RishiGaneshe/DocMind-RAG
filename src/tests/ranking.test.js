import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  fuseRankings,
  jaccard,
  trigrams,
  suppressDuplicates
} from '../rag/ranking.js'

describe('fuseRankings', () => {
  it('ranks a document agreed on by both lanes above either lane leader', () => {
    const dense = ['a', 'b', 'c']
    const lexical = ['d', 'b', 'e']

    const fused = fuseRankings([dense, lexical], 60)

    assert.equal(fused[0].id, 'b')
  })

  it('keeps ids unique across lanes', () => {
    const fused = fuseRankings([['a', 'b'], ['b', 'a']], 60)

    assert.deepEqual(
      fused.map((entry) => entry.id).sort(),
      ['a', 'b']
    )
  })

  it('ignores an empty lane rather than reordering around it', () => {
    const single = fuseRankings([['a', 'b', 'c']], 60)
    const withEmpty = fuseRankings([['a', 'b', 'c'], []], 60)

    assert.deepEqual(
      withEmpty.map((entry) => entry.id),
      single.map((entry) => entry.id)
    )
  })

  it('gives a lower k a sharper preference for rank 1', () => {
    const sharp = fuseRankings([['a'], ['b', 'a']], 1)
    const flat = fuseRankings([['a'], ['b', 'a']], 1000)

    const spread = (fused) => fused[0].fusedScore - fused[1].fusedScore

    assert.ok(spread(sharp) > spread(flat))
  })
})

describe('trigram similarity', () => {
  it('treats identical text as fully similar', () => {
    const text = 'quarterly revenue rose by twelve percent'

    assert.equal(jaccard(trigrams(text), trigrams(text)), 1)
  })

  it('normalises whitespace so reflowed text still matches', () => {
    const a = trigrams('audit logs are retained for 90 days')
    const b = trigrams('audit  logs\nare   retained for 90 days')

    assert.equal(jaccard(a, b), 1)
  })

  it('scores unrelated text near zero', () => {
    const a = trigrams('the retention period for audit logs')
    const b = trigrams('quarterly dividend declared by the board')

    assert.ok(jaccard(a, b) < 0.2)
  })

  it('returns zero when either side is shorter than a trigram', () => {
    assert.equal(jaccard(trigrams('ab'), trigrams('anything at all')), 0)
  })
})

describe('suppressDuplicates', () => {
  it('drops a chunk that repeats one already kept', () => {
    const shared = 'Audit logs are retained for 90 days and deleted nightly. '

    const kept = suppressDuplicates(
      [
        { id: '1', text: `${shared}Deletion runs at 02:00 UTC.` },
        { id: '2', text: `${shared}Deletion runs at 02:00 UTC.` },
        { id: '3', text: 'Dividends are declared each quarter by the board.' }
      ],
      0.85
    )

    assert.deepEqual(
      kept.map((candidate) => candidate.id),
      ['1', '3']
    )
  })

  it('keeps overlapping neighbours that still add new text', () => {
    const kept = suppressDuplicates(
      [
        {
          id: '1',
          text: 'Section 4 covers retention. Audit logs last 90 days.'
        },
        {
          id: '2',
          text:
            'Audit logs last 90 days. Section 5 covers the deletion jobs, ' +
            'which run nightly at 02:00 UTC across every region we operate in.'
        }
      ],
      0.85
    )

    assert.equal(kept.length, 2)
  })

  it('preserves input order for what it keeps', () => {
    const candidates = [
      { id: 'a', text: 'alpha content about invoices and billing cycles' },
      { id: 'b', text: 'beta content about shipping and customs paperwork' },
      { id: 'c', text: 'gamma content about payroll and tax withholding' }
    ]

    assert.deepEqual(
      suppressDuplicates(candidates, 0.85).map((entry) => entry.id),
      ['a', 'b', 'c']
    )
  })
})
