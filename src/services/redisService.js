import Redis from 'ioredis'
import { config } from '../config.js'

let redis = null

const TOKEN_BLACKLIST_PREFIX = 'token:blacklist:'


export const connectRedis = async () => {
  return new Promise((resolve, reject) => {
    redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 5) {
          console.error('Redis: max retries reached, giving up')
          return null
        }
        const delay = Math.min(times * 200, 2000)
        return delay
      },
      lazyConnect: true
    })

    redis.on('error', (err) => {
      console.error('Redis connection error:', err.message)
    })

    redis.on('connect', () => {
      console.log('Redis connected')
    })

    redis
      .connect()
      .then(() => resolve(redis))
      .catch((err) => {
        console.error('Failed to connect to Redis:', err.message)
        reject(err)
      })
  })
}

export const getRedis = () => {
  if (!redis) {
    throw new Error('Redis not initialized. Call connectRedis() first.')
  }
  return redis
}

export const blacklistToken = async (jti, expiresInSeconds) => {
  if (!redis) return
  const key = `${TOKEN_BLACKLIST_PREFIX}${jti}`
  await redis.set(key, '1', 'EX', Math.ceil(expiresInSeconds))
}

export const isTokenBlacklisted = async (jti) => {
  if (!redis) return false
  const key = `${TOKEN_BLACKLIST_PREFIX}${jti}`
  const result = await redis.exists(key)
  return result === 1
}

export const disconnectRedis = async () => {
  if (redis) {
    await redis.quit()
    redis = null
    console.log('Redis disconnected')
  }
}
