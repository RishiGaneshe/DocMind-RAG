import path from 'path'
import { fileURLToPath } from 'url'
import { Umzug, SequelizeStorage } from 'umzug'
import { sequelize } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const MIGRATIONS_GLOB = path
  .join(__dirname, '..', 'migrations', '*.js')
  .replace(/\\/g, '/')


export const umzug = new Umzug({
  migrations: { glob: MIGRATIONS_GLOB },
  context: sequelize,
  storage: new SequelizeStorage({
    sequelize,
    tableName: 'schema_migrations'
  }),
  logger: {
    info: ({ event, name }) => {
      if (event === 'migrating' || event === 'reverting') {
        console.log(`[MIGRATE] ${event} ${name}`)
      }
    },
    warn: (message) => console.warn('[MIGRATE]', message),
    error: (message) => console.error('[MIGRATE]', message),
    debug: () => {}
  }
})

const MIGRATION_LOCK_ID = 728411


export const runMigrations = async () => {
  const applied = await sequelize.transaction(async (transaction) => {
    await sequelize.query('SELECT pg_advisory_xact_lock(:id)', {
      replacements: { id: MIGRATION_LOCK_ID },
      transaction
    })

    return await umzug.up()
  })

  if (applied.length === 0) {
    console.log('Database schema up to date')
  } else {
    console.log(`Applied ${applied.length} migration(s)`)
  }

  return applied.map((migration) => migration.name)
}

export const pendingMigrations = async () =>
  (await umzug.pending()).map((migration) => migration.name)
