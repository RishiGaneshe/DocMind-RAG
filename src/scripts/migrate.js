#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   npm run migrate            apply every pending migration
 *   npm run migrate:status     list applied and pending migrations
 *   npm run migrate:undo       revert the most recent migration
 *
 * Kept separate from the server so a deploy can migrate before starting any
 * instance, which is the only ordering that works when more than one is running.
 */
import 'dotenv/config'
import { sequelize } from '../services/db.js'
import { umzug, runMigrations } from '../services/migrator.js'

const commands = {
  up: async () => {
    const applied = await runMigrations()

    applied.forEach((name) => console.log(`  applied ${name}`))
  },

  status: async () => {
    const [executed, pending] = await Promise.all([umzug.executed(), umzug.pending()])

    console.log(`applied (${executed.length}):`)
    executed.forEach((migration) => console.log(`  ${migration.name}`))

    console.log(`pending (${pending.length}):`)
    pending.forEach((migration) => console.log(`  ${migration.name}`))
  },

  undo: async () => {
    const reverted = await umzug.down()

    if (reverted.length === 0) {
      console.log('Nothing to revert')
      return
    }

    reverted.forEach((migration) => console.log(`  reverted ${migration.name}`))
  }
}

const command = process.argv[2] ?? 'up'

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(', ')}`)
  process.exit(1)
}

try {
  await commands[command]()
} catch (error) {
  console.error(`Migration ${command} failed:`, error.message)
  process.exitCode = 1
} finally {
  await sequelize.close()
}
