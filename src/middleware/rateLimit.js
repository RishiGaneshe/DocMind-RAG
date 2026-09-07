import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { rateLimitConfig } from '../config.js'

/**
 * Buckets by authenticated user first and IP second.
 *
 * Keying on IP alone punishes every user behind one office NAT for the busiest
 * of them, and keying on the user alone leaves unauthenticated routes — where
 * the abuse actually starts — with no bucket at all. `ipKeyGenerator` is used
 * rather than raw `req.ip` because it normalises IPv6 to a /56 prefix, so a
 * client with a whole address range cannot mint a fresh bucket per request.
 *
 * The field is `userId`, not `id`: that is what `authenticate` puts on `req.user`
 * from the JWT payload. Reading `id` here silently sent every authenticated
 * request down the IP branch — the exact NAT problem this comment claims to
 * avoid.
 */
const keyFor = (req) =>
  req.user?.userId ? `u:${req.user.userId}` : `ip:${ipKeyGenerator(req.ip)}`

const build = (max, message) =>
  rateLimit({
    windowMs: rateLimitConfig.windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyFor,
    // Failed logins and rejected uploads are exactly what a limiter is for, so
    // they stay counted; only the limiter's own 429s are skipped.
    handler: (req, res) => {
      console.warn(`[RATE LIMIT] ${keyFor(req)} on ${req.method} ${req.originalUrl}`)

      res.status(429).json({
        success: false,
        error: message,
        code: 'RATE_LIMITED',
        retryAfterSeconds: Math.ceil(rateLimitConfig.windowMs / 1000)
      })
    }
  })

/**
 * A pass-through when limiting is disabled, so the router wiring does not need
 * to branch and a misconfiguration cannot silently drop the limiter from one
 * route while keeping it on another.
 */
const optional = (middleware) =>
  rateLimitConfig.enabled ? middleware : (req, res, next) => next()

export const generalLimiter = optional(
  build(rateLimitConfig.generalMax, 'Too many requests. Please slow down.')
)

export const queryLimiter = optional(
  build(
    rateLimitConfig.queryMax,
    'Too many questions in a short period. Please wait a moment and try again.'
  )
)

export const uploadLimiter = optional(
  build(
    rateLimitConfig.uploadMax,
    'Too many uploads in a short period. Please wait a moment and try again.'
  )
)

export const authLimiter = optional(
  build(
    rateLimitConfig.authMax,
    'Too many authentication attempts. Please wait a moment and try again.'
  )
)
