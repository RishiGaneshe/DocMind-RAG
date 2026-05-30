import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { config } from '../config.js'
import { User, Tenant } from '../models/index.js'
import { blacklistToken } from './redisService.js'



const generateJti = () => crypto.randomUUID()


const buildTokenPayload = (user) => ({
  userId: user.id,
  email: user.email,
  tenantId: user.tenantId || null,
  role: user.role
})


export const generateTokens = (user) => {
  const accessJti = generateJti()
  const refreshJti = generateJti()

  const payload = buildTokenPayload(user)

  const accessToken = jwt.sign(
    { ...payload, jti: accessJti, type: 'access' },
    config.jwtSecret,
    { expiresIn: config.jwtAccessExpiry }
  )

  const refreshToken = jwt.sign(
    { ...payload, jti: refreshJti, type: 'refresh' },
    config.jwtSecret,
    { expiresIn: config.jwtRefreshExpiry }
  )

  return { accessToken, refreshToken }
}


export const registerUser = async ({ email, password, firstName, lastName }) => {
  const existingUser = await User.findOne({ where: { email: email.toLowerCase().trim() } })

  if (existingUser) {
    const error = new Error('An account with this email already exists')
    error.status = 409
    throw error
  }

  const user = await User.create({
    email,
    password,
    firstName,
    lastName
  })

  const safeUser = user.toSafeJSON()
  const tokens = generateTokens(user)

  return { user: safeUser, ...tokens }
}


export const loginUser = async ({ email, password }) => {
  const user = await User.findOne({
    where: { email: email.toLowerCase().trim() }
  })

  if (!user || !user.isActive) {
    const error = new Error('Invalid email or password')
    error.status = 401
    throw error
  }

  const isPasswordValid = await user.verifyPassword(password)

  if (!isPasswordValid) {
    const error = new Error('Invalid email or password')
    error.status = 401
    throw error
  }

  await user.update({ lastLoginAt: new Date() })

  const safeUser = user.toSafeJSON()
  const tokens = generateTokens(user)

  return { user: safeUser, ...tokens }
}


export const refreshAccessToken = async (refreshToken) => {
  if (!refreshToken) {
    const error = new Error('Refresh token is required')
    error.status = 400
    throw error
  }

  let decoded
  try {
    decoded = jwt.verify(refreshToken, config.jwtSecret)
  } catch (err) {
    const error = new Error('Invalid or expired refresh token')
    error.status = 401
    throw error
  }

  if (decoded.type !== 'refresh') {
    const error = new Error('Invalid token type')
    error.status = 401
    throw error
  }

  const user = await User.findByPk(decoded.userId)

  if (!user || !user.isActive) {
    const error = new Error('User not found or inactive')
    error.status = 401
    throw error
  }

  const tokens = generateTokens(user)

  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken
  }
}


export const logoutUser = async (accessToken, refreshToken) => {
  try {
    const accessDecoded = jwt.decode(accessToken)
    if (accessDecoded?.jti && accessDecoded?.exp) {
      const ttl = accessDecoded.exp - Math.floor(Date.now() / 1000)
      if (ttl > 0) {
        await blacklistToken(accessDecoded.jti, ttl)
      }
    }
  } catch {
    
  }

  try {
    const refreshDecoded = jwt.decode(refreshToken)
    if (refreshDecoded?.jti && refreshDecoded?.exp) {
      const ttl = refreshDecoded.exp - Math.floor(Date.now() / 1000)
      if (ttl > 0) {
        await blacklistToken(refreshDecoded.jti, ttl)
      }
    }
  } catch {
   
  }
}


export const getUserProfile = async (userId) => {
  const user = await User.findByPk(userId, {
    include: [
      {
        model: Tenant,
        as: 'tenant',
        attributes: ['id', 'name', 'slug', 'apiKey']
      }
    ]
  })

  if (!user) {
    const error = new Error('User not found')
    error.status = 404
    throw error
  }

  return user.toSafeJSON()
}
