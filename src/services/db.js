import { Sequelize } from 'sequelize'
import { config } from '../config.js'

const url = config.databaseUrl

if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Add it to .env as ' +
      'DATABASE_URL=postgresql://user:password@host:5432/database'
  )
}

const duplicatedKey = /^[A-Z_][A-Z0-9_]*=/.exec(url)

if (duplicatedKey) {
  throw new Error(
    `DATABASE_URL begins with "${duplicatedKey[0]}" — the key name was ` +
      'written twice on one line of .env. Remove the duplicated prefix so the ' +
      'value starts with postgresql://'
  )
}

if (!/^postgres(ql)?:\/\//.test(url)) {
  throw new Error(
    `DATABASE_URL has no postgresql:// scheme (starts with "${url.slice(0, 12)}"). ` +
      'Expected postgresql://user:password@host:5432/database'
  )
}

const isSSL = url.includes('sslmode') || url.includes('neon')

export const sequelize = new Sequelize(url, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: isSSL
    ? {
        ssl: {  
          require: false,
          rejectUnauthorized: false
        }
      }
    : {},
  pool: {
    max: 10,
    min: 0,
    acquire: 20000,
    idle: 5000,
    evict: 5000
  }    
})

