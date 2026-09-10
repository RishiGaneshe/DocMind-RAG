import { getRedisSafe } from './redisService.js'
import { publicApiConfig } from '../config.js'

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

const DRAIN_SCRIPT = `
  local value = redis.call('GET', KEYS[1])
  if value then redis.call('DEL', KEYS[1]) end
  return value or 0
`

const DAY_TTL_SECONDS = 60 * 60 * 48

export const dayStamp = (date = new Date()) =>
  date.toISOString().slice(0, 10).replace(/-/g, '')

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

export const bumpTotalRequests = async (keyId) => {
  const redis = getRedisSafe()

  if (!redis) return

  try {
    await redis.incr(`${TOTAL_PREFIX}${keyId}`)
  } catch (error) {
    console.warn('[QUOTA] total counter failed:', error.message)
  }
}

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
