import { Sequelize } from 'sequelize'
import { config } from '../config.js'

const isSSL = config.databaseUrl?.includes('sslmode') || config.databaseUrl?.includes('neon')

export const sequelize = new Sequelize(config.databaseUrl, {
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

