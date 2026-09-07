import { getRedisSafe } from './redisService.js'
import { publicApiConfig } from '../config.js'

/**
 * Redis-backed fixed-window counters.
 *
 * `express-rate-limit`'s default store lives in process memory, which means N
 * instances allow N times the configured limit. That is tolerable for the
 * dashboard and not tolerable for the public chat route, where the limit is the
 * only thing standing between a leaked key and an unbounded bill. These counters
 * live in Redis and therefore hold across processes.
 *
 * Fixed windows rather than sliding: a burst at a window boundary can briefly
 * reach twice the limit, which costs a handful of extra requests. A sliding
 * window would cost a sorted set per key per window to prevent that, and the
 * daily quota already caps the total.
 */

// INCR and EXPIRE in one round trip. Doing them as two commands lets concurrent
// callers both observe `current > 1`, in which case nobody sets the TTL and the
// counter never resets — a limiter that permanently locks the key out.
const INCREMENT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return { current, redis.call('TTL', KEYS[1]) }
`

const RATE_PREFIX = 'q:rate:'
const DAY_PREFIX = 'q:day:'
const TOTAL_PREFIX = 'q:total:'

// Reads and clears in one atomic step. Two commands would lose whatever landed
// between them, and this counter is the one that feeds the durable
// `api_keys.totalRequests` figure.
const DRAIN_SCRIPT = `
  local value = redis.call('GET', KEYS[1])
  if value then redis.call('DEL', KEYS[1]) end
  return value or 0
`

// Two days, so a counter written just before midnight is still readable for the
// usage endpoint after the day rolls over.
const DAY_TTL_SECONDS = 60 * 60 * 48

export const dayStamp = (date = new Date()) =>
  date.toISOString().slice(0, 10).replace(/-/g, '')

/**
 * Thrown rather than returned when Redis is unreachable, so a caller cannot
 * accidentally treat "could not check" as "under the limit".
 */
const unavailable = () => {
  const error = new Error('Quota service is unavailable')
  error.code = 'QUOTA_UNAVAILABLE'
  return error
}

const increment = async (key, windowSeconds) => {
  const redis = getRedisSafe()

  if (!redis) throw unavailable()

  try {
    const [count, ttl] = await redis.eval(INCREMENT_SCRIPT, 1, key, windowSeconds)

    return {
      count: Number(count),
      resetSeconds: Number(ttl) > 0 ? Number(ttl) : windowSeconds
    }
  } catch (error) {
    console.error('[QUOTA] increment failed:', error.message)
    throw unavailable()
  }
}

/**
 * Consumes one unit against a fixed window.
 *
 * A non-positive `limit` means unlimited and skips Redis entirely, so an
 * operator can disable a tier without the counter still costing a round trip.
 */
export const consumeRate = async (bucket, limit, windowSeconds = publicApiConfig.windowSeconds) => {
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, count: 0, limit: Infinity, remaining: Infinity, resetSeconds: 0 }
  }

  const { count, resetSeconds } = await increment(`${RATE_PREFIX}${bucket}`, windowSeconds)

  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(0, limit - count),
    resetSeconds
  }
}

/**
 * Consumes one unit against today's quota for a key.
 *
 * The window is a UTC calendar day rather than a rolling 24 hours: an owner
 * reading "412 of 500 used today" against a rolling window has no way to know
 * when capacity returns.
 */
export const consumeDailyQuota = async (keyId, quota) => {
  if (!Number.isFinite(quota) || quota <= 0) {
    return { allowed: true, used: 0, quota: Infinity, remaining: Infinity }
  }

  const { count } = await increment(`${DAY_PREFIX}${keyId}:${dayStamp()}`, DAY_TTL_SECONDS)

  return {
    allowed: count <= quota,
    used: count,
    quota,
    remaining: Math.max(0, quota - count)
  }
}

/**
 * Reads today's usage without consuming. Returns `null` rather than throwing
 * when Redis is down, because this only ever feeds a dashboard number — and
 * `null` rather than 0 because "0 of 500 used" during an outage is a lie an
 * owner would act on.
 */
export const peekDailyUsage = async (keyId, date = new Date()) => {
  const redis = getRedisSafe()

  if (!redis) return null

  try {
    const raw = await redis.get(`${DAY_PREFIX}${keyId}:${dayStamp(date)}`)
    return Number(raw ?? 0)
  } catch (error) {
    console.warn('[QUOTA] usage read failed:', error.message)
    return null
  }
}

/**
 * Counts one request against a key's lifetime total.
 *
 * Kept in Redis and folded into `api_keys.totalRequests` once a minute by
 * `touchApiKey`, so a busy widget costs one UPDATE per minute rather than one
 * per message. Never throws: a lost count is a cosmetic problem.
 */
export const bumpTotalRequests = async (keyId) => {
  const redis = getRedisSafe()

  if (!redis) return

  try {
    await redis.incr(`${TOTAL_PREFIX}${keyId}`)
  } catch (error) {
    console.warn('[QUOTA] total counter failed:', error.message)
  }
}

/**
 * Takes everything counted since the last drain and clears the counter.
 * Returns 0 when there is nothing to fold in or Redis is unreachable.
 */
export const drainTotalRequests = async (keyId) => {
  const redis = getRedisSafe()

  if (!redis) return 0

  try {
    const value = await redis.eval(DRAIN_SCRIPT, 1, `${TOTAL_PREFIX}${keyId}`)
    return Number(value ?? 0)
  } catch (error) {
    console.warn('[QUOTA] total counter drain failed:', error.message)
    return 0
  }
}

/**
 * Clears a key's rate window and today's quota.
 *
 * Nothing in the request path calls this — rotation issues a new row with a new
 * id, so the replacement starts with empty counters by construction. It exists
 * for operator use: lifting a limit for a key that has been throttled by a burst,
 * without waiting out the window.
 */
export const resetKeyCounters = async (keyId) => {
  const redis = getRedisSafe()

  if (!redis) return

  try {
    await redis.del(
      `${DAY_PREFIX}${keyId}:${dayStamp()}`,
      `${RATE_PREFIX}key:${keyId}`
    )
  } catch (error) {
    console.warn('[QUOTA] counter reset failed:', error.message)
  }
}
