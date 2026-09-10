import {
  resolveApiKey,
  keyStatus,
  touchApiKey,
  looksLikeApiKey
} from '../services/apiKeyService.js'
import {
  consumeRate,
  consumeDailyQuota,
  bumpTotalRequests
} from '../services/quotaService.js'
import { publicApiConfig } from '../config.js'

const BEARER = /^Bearer\s+(\S+)$/i

const extractKey = (req) => {
  const header = req.headers['x-api-key']

  if (typeof header === 'string' && header.trim()) return header.trim()

  const authorization = req.headers.authorization

  if (typeof authorization === 'string') {
    const match = authorization.match(BEARER)
    if (match) return match[1]
  }

  return null
}

const reject = (res, status, error, code) =>
  res.status(status).json({ success: false, error, code })

export const apiKeyAuth = async (req, res, next) => {
  try {
    const raw = extractKey(req)

    if (!raw) {
      return reject(
        res,
        401,
        'An API key is required. Send it as the X-Api-Key header.',
        'API_KEY_MISSING'
      )
    }

    if (!looksLikeApiKey(raw)) {
      return reject(res, 401, 'That API key is not valid.', 'API_KEY_INVALID')
    }

    const record = await resolveApiKey(raw)

    if (!record) {
      return reject(res, 401, 'That API key is not valid.', 'API_KEY_INVALID')
    }

    const status = keyStatus(record)

    if (status === 'revoked') {
      return reject(
        res,
        401,
        'This API key has been revoked.',
        'API_KEY_REVOKED'
      )
    }

    if (status === 'expired') {
      return reject(
        res,
        401,
        'This API key has expired. It was rotated — update the key in your site.',
        'API_KEY_EXPIRED'
      )
    }

    req.apiKey = record
    req.tenantId = record.tenantId

    next()
  } catch (error) {
    console.error('API key authentication error:', error)

    return reject(
      res,
      500,
      'Authentication service error',
      'AUTH_UNAVAILABLE'
    )
  }
}

export const requireScope = (scope) => (req, res, next) => {
  if (!req.apiKey) {
    return reject(res, 500, 'Scope check ran before key resolution')
  }

  if (!req.apiKey.scopes.includes(scope)) {
    console.warn(`[API KEY] ${req.apiKey.keyPrefix}: missing scope ${scope}`)

    return reject(
      res,
      403,
      `This API key does not have the "${scope}" permission.`,
      'SCOPE_FORBIDDEN'
    )
  }

  next()
}

const setRateHeaders = (res, result) => {
  if (!Number.isFinite(result.limit)) return

  res.setHeader('RateLimit-Limit', result.limit)
  res.setHeader('RateLimit-Remaining', result.remaining)
  res.setHeader('RateLimit-Reset', result.resetSeconds)
}

export const enforceQuota = ({ daily = false, visitor = false } = {}) =>
  async (req, res, next) => {
    const key = req.apiKey

    if (!key) {
      return reject(res, 500, 'Quota check ran before key resolution')
    }

    try {
      const perMinute = key.rateLimitPerMinute ?? publicApiConfig.defaultRatePerMinute
      const keyResult = await consumeRate(`key:${key.id}`, perMinute)

      setRateHeaders(res, keyResult)

      if (!keyResult.allowed) {
        console.warn(
          `[QUOTA] ${key.keyPrefix}: key rate ${keyResult.count}/${perMinute}`
        )

        res.setHeader('Retry-After', keyResult.resetSeconds)

        return reject(
          res,
          429,
          'This chat is receiving too many messages right now. Please wait a moment.',
          'RATE_LIMITED'
        )
      }

      if (visitor) {
        // `trust proxy` is set on the app, so `req.ip` is the client address
        // rather than the load balancer's.
        const visitorResult = await consumeRate(
          `key:${key.id}:ip:${req.ip}`,
          publicApiConfig.visitorRatePerMinute
        )

        if (!visitorResult.allowed) {
          console.warn(
            `[QUOTA] ${key.keyPrefix}: visitor ${req.ip} rate ` +
              `${visitorResult.count}/${publicApiConfig.visitorRatePerMinute}`
          )

          res.setHeader('Retry-After', visitorResult.resetSeconds)

          return reject(
            res,
            429,
            'You are sending messages too quickly. Please wait a moment.',
            'RATE_LIMITED'
          )
        }
      }

      if (daily) {
        const quota = key.dailyQuota ?? publicApiConfig.defaultDailyQuota
        const quotaResult = await consumeDailyQuota(key.id, quota)

        if (Number.isFinite(quotaResult.quota)) {
          res.setHeader('X-Quota-Limit', quotaResult.quota)
          res.setHeader('X-Quota-Remaining', quotaResult.remaining)
        }

        if (!quotaResult.allowed) {
          console.warn(
            `[QUOTA] ${key.keyPrefix}: daily quota exhausted ` +
              `(${quotaResult.used}/${quota})`
          )

          return reject(
            res,
            429,
            'This chat has reached its daily message limit. Please try again tomorrow.',
            'QUOTA_EXCEEDED'
          )
        }
      }

      // Bookkeeping for allowed requests only, so the durable counter tracks
      // what was actually served — and therefore paid for.
      bumpTotalRequests(key.id).catch(() => {})
      touchApiKey(key.id, req.ip).catch(() => {})

      next()
    } catch (error) {
      if (error.code === 'QUOTA_UNAVAILABLE') {
        console.error(
          `[QUOTA] failing closed for ${key.keyPrefix}: quota store unreachable`
        )

        res.setHeader('Retry-After', 30)

        return reject(
          res,
          503,
          'The chat service is temporarily unavailable. Please try again shortly.',
          'QUOTA_UNAVAILABLE'
        )
      }

      console.error('Quota enforcement error:', error)

      return reject(res, 500, 'Internal server error')
    }
  }
