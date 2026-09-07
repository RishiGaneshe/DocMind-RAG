import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  dayStamp,
  consumeRate,
  consumeDailyQuota,
  peekDailyUsage,
  bumpTotalRequests,
  drainTotalRequests,
  resetKeyCounters
} from '../services/quotaService.js'

/**
 * These run with no Redis connected, which is exactly the interesting case: the
 * public chat route spends money at three paid providers on every request, so
 * "the counter store is unreachable" must not be indistinguishable from "this
 * request is within quota".
 *
 * The two behaviours asserted here are the whole contract:
 *   - a limit that must be checked and cannot be → throw QUOTA_UNAVAILABLE
 *   - a limit that is switched off entirely → allow without touching Redis
 *
 * Bookkeeping counters take the opposite line and stay silent, because a lost
 * usage figure is cosmetic.
 */

describe('dayStamp', () => {
  test('is a UTC YYYYMMDD stamp', () => {
    assert.equal(dayStamp(new Date('2026-03-05T23:30:00Z')), '20260305')
    assert.match(dayStamp(), /^\d{8}$/)
  })

  test('rolls over on the UTC day, not the local one', () => {
    // A calendar day is what an owner can reason about — "412 of 500 used
    // today" against a rolling window never tells them when capacity returns.
    assert.equal(dayStamp(new Date('2026-03-05T23:59:59Z')), '20260305')
    assert.equal(dayStamp(new Date('2026-03-06T00:00:00Z')), '20260306')
  })
})

describe('with the counter store unreachable', () => {
  test('a rate limit that must be enforced fails closed', async () => {
    await assert.rejects(
      () => consumeRate('key:test', 30),
      (error) => {
        assert.equal(error.code, 'QUOTA_UNAVAILABLE')
        return true
      }
    )
  })

  test('a daily quota that must be enforced fails closed', async () => {
    await assert.rejects(
      () => consumeDailyQuota('key-id', 500),
      (error) => {
        assert.equal(error.code, 'QUOTA_UNAVAILABLE')
        return true
      }
    )
  })

  test('usage reads answer "unknown" rather than "zero"', async () => {
    // A dashboard showing 0 of 500 used during a Redis outage is a lie an owner
    // would act on; null lets the UI say it does not know.
    assert.equal(await peekDailyUsage('key-id'), null)
  })

  test('bookkeeping counters stay silent', async () => {
    await bumpTotalRequests('key-id')
    await resetKeyCounters('key-id')

    assert.equal(await drainTotalRequests('key-id'), 0)
  })
})

describe('a limit switched off entirely', () => {
  for (const limit of [0, -1, Number.NaN, undefined, null, 'thirty']) {
    test(`consumeRate(${String(limit)}) allows without a round trip`, async () => {
      const result = await consumeRate('key:test', limit)

      assert.equal(result.allowed, true)
      assert.equal(result.limit, Infinity)
      assert.equal(result.remaining, Infinity)
    })
  }

  test('consumeDailyQuota does the same', async () => {
    const result = await consumeDailyQuota('key-id', 0)

    assert.equal(result.allowed, true)
    assert.equal(result.quota, Infinity)
  })

  test('an infinite limit emits no RateLimit headers, since there is no number to send', async () => {
    const result = await consumeRate('key:test', 0)

    assert.equal(Number.isFinite(result.limit), false)
  })
})

