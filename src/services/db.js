import { Sequelize } from 'sequelize'
import { config } from '../config.js'

// Sequelize's own failure for a malformed URL is "Dialect needs to be
// explicitly supplied", which points at the code rather than at the line of
// .env actually responsible. These two checks name the problem instead.
const url = config.databaseUrl

if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Add it to .env as ' +
      'DATABASE_URL=postgresql://user:password@host:5432/database'
  )
}

// dotenv splits on the first "=" only, so a line written as
// `DATABASE_URL=DATABASE_URL=postgres://…` parses without complaint and leaves
// the key name inside its own value. Nothing downstream can detect that except
// by looking at the value.
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

