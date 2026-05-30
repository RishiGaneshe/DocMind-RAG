import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { isTokenBlacklisted } from '../services/redisService.js'

export const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid access token.'
      })
    }

    const token = authHeader.split(' ')[1]

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Token is missing.'
      })
    }

    let decoded
    try {
      decoded = jwt.verify(token, config.jwtSecret)
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          error: 'Access token has expired. Please refresh your token.',
          code: 'TOKEN_EXPIRED'
        })
      }
      return res.status(401).json({
        success: false,
        error: 'Invalid access token.'
      })
    }

    if (decoded.type !== 'access') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token type. Access token required.'
      })
    }

    // Check Redis blacklist
    const blacklisted = await isTokenBlacklisted(decoded.jti)
    if (blacklisted) {
      return res.status(401).json({
        success: false,
        error: 'Token has been revoked. Please log in again.',
        code: 'TOKEN_REVOKED'
      })
    }

    // Attach user info to request
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      tenantId: decoded.tenantId,
      role: decoded.role
    }

    // Attach raw token for logout
    req.accessToken = token

    next()
  } catch (error) {
    console.error('Authentication middleware error:', error)
    return res.status(500).json({
      success: false,
      error: 'Authentication service error'
    })
  }
}
