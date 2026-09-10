import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { rateLimitConfig } from '../config.js'

// Key rate limits by authenticated userId or IP
const keyFor = (req) =>
  req.user?.userId ? `u:${req.user.userId}` : `ip:${ipKeyGenerator(req.ip)}`

const build = (max, message) =>
  rateLimit({
    windowMs: rateLimitConfig.windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: keyFor,
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

// Pass-through when rate limiting is disabled
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
