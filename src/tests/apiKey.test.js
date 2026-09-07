import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'

import { hashKey, looksLikeApiKey, keyStatus } from '../services/apiKeyService.js'
import { apiKeyAuth, requireScope } from '../middleware/apiKeyAuth.js'

/**
 * The structural check and the status check are the two places a bad key is
 * supposed to die before anything expensive happens, so both are tested against
 * the shapes an attacker would actually send rather than only against a
 * well-formed key.
 */

const mintPlaintext = (scheme = 'pk') =>
  `${scheme}_live_${crypto.randomBytes(32).toString('base64url')}`

const run = async (middleware, req) => {
  let nextCalled = false
  let status
  let payload

  const res = {
    status(code) {
      status = code
      return this
    },
    json(value) {
      payload = value
      return this
    }
  }

  await middleware(req, res, () => {
    nextCalled = true
  })

  return { nextCalled, status, payload }
}

describe('looksLikeApiKey', () => {
  test('accepts a freshly minted key of either type', () => {
    assert.equal(looksLikeApiKey(mintPlaintext('pk')), true)
    assert.equal(looksLikeApiKey(mintPlaintext('sk')), true)
  })

  test('the minted secret is 43 base64url characters, inside the bound', () => {
    const secret = mintPlaintext().slice('pk_live_'.length)

    assert.equal(secret.length, 43)
    assert.match(secret, /^[A-Za-z0-9_-]+$/)
  })

  const rejected = [
    ['pk_test_' + 'a'.repeat(43), 'a non-live environment prefix'],
    ['tk_live_' + 'a'.repeat(43), 'an unknown scheme'],
    ['pk_live_' + 'a'.repeat(39), 'too short'],
    ['pk_live_' + 'a'.repeat(65), 'too long'],
    ['pk_live_' + 'a'.repeat(42) + '+', 'a character outside base64url'],
    ['pk_live_' + 'a'.repeat(42) + '/', 'a path separator'],
    ['pk_live_', 'no secret at all'],
    ['', 'the empty string'],
    [' pk_live_' + 'a'.repeat(43), 'leading whitespace']
  ]

  for (const [value, why] of rejected) {
    test(`rejects ${why}`, () => {
      assert.equal(looksLikeApiKey(value), false)
    })
  }

  test('rejects non-strings without throwing', () => {
    assert.equal(looksLikeApiKey(undefined), false)
    assert.equal(looksLikeApiKey(null), false)
    assert.equal(looksLikeApiKey(12345), false)
    assert.equal(looksLikeApiKey({}), false)
  })
})

describe('hashKey', () => {
  test('is a deterministic 64-character hex digest', () => {
    const raw = mintPlaintext()

    assert.match(hashKey(raw), /^[0-9a-f]{64}$/)
    assert.equal(hashKey(raw), hashKey(raw))
  })

  test('differs for keys that differ by one character', () => {
    assert.notEqual(hashKey('pk_live_aaaa'), hashKey('pk_live_aaab'))
  })
})

describe('keyStatus', () => {
  const hour = 60 * 60 * 1000

  test('a plain key is active', () => {
    assert.equal(keyStatus({ revokedAt: null, expiresAt: null }), 'active')
  })

  test('revocation wins over an expiry still in the future', () => {
    assert.equal(
      keyStatus({
        revokedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + hour).toISOString()
      }),
      'revoked'
    )
  })

  test('a grace window still open leaves the key active', () => {
    assert.equal(
      keyStatus({ revokedAt: null, expiresAt: new Date(Date.now() + hour).toISOString() }),
      'active'
    )
  })

  test('a grace window that has closed expires the key', () => {
    assert.equal(
      keyStatus({ revokedAt: null, expiresAt: new Date(Date.now() - hour).toISOString() }),
      'expired'
    )
  })

  test('is evaluated against the clock, not baked into the record', () => {
    // The same record read either side of its own expiry must answer
    // differently — that is the property that stops a cached key from
    // outliving its grace window for the rest of the cache TTL.
    const record = { revokedAt: null, expiresAt: new Date(Date.now() + 40).toISOString() }

    assert.equal(keyStatus(record), 'active')

    const spin = Date.now() + 60
    while (Date.now() < spin) { /* deliberately busy: 60ms, no timer needed */ }

    assert.equal(keyStatus(record), 'expired')
  })
})

describe('requireScope', () => {
  const gate = requireScope('chat:query')

  test('is a server error if it runs before key resolution', async () => {
    const { status, nextCalled } = await run(gate, { apiKey: undefined })

    assert.equal(status, 500)
    assert.equal(nextCalled, false)
  })

  test('admits a key holding the scope', async () => {
    const { nextCalled } = await run(gate, {
      apiKey: { keyPrefix: 'pk_live_abc123', scopes: ['chat:query', 'chat:config'] }
    })

    assert.equal(nextCalled, true)
  })

  test('answers 403, not 401 — the key is valid, just not permitted here', async () => {
    const { status, payload, nextCalled } = await run(gate, {
      apiKey: { keyPrefix: 'pk_live_abc123', scopes: ['chat:config'] }
    })

    assert.equal(status, 403)
    assert.equal(payload.code, 'SCOPE_FORBIDDEN')
    assert.equal(nextCalled, false)
  })
})

describe('apiKeyAuth — rejections that cost no I/O', () => {
  test('no credential at all', async () => {
    const { status, payload, nextCalled } = await run(apiKeyAuth, { headers: {} })

    assert.equal(status, 401)
    assert.equal(payload.code, 'API_KEY_MISSING')
    assert.equal(nextCalled, false)
  })

  test('a malformed X-Api-Key never reaches the database', async () => {
    const { status, payload } = await run(apiKeyAuth, {
      headers: { 'x-api-key': 'obviously-not-a-key' }
    })

    assert.equal(status, 401)
    assert.equal(payload.code, 'API_KEY_INVALID')
  })

  test('an Authorization: Bearer credential is read as a fallback', async () => {
    // A blank X-Api-Key must not shadow the Authorization header: the give-away
    // is that this is INVALID rather than MISSING.
    const { payload } = await run(apiKeyAuth, {
      headers: { 'x-api-key': '   ', authorization: 'Bearer still-not-a-key' }
    })

    assert.equal(payload.code, 'API_KEY_INVALID')
  })

  test('a non-Bearer Authorization scheme is not treated as a key', async () => {
    const { payload } = await run(apiKeyAuth, {
      headers: { authorization: 'Basic dXNlcjpwYXNz' }
    })

    assert.equal(payload.code, 'API_KEY_MISSING')
  })

  test('a key in the query string is not accepted', async () => {
    const { payload } = await run(apiKeyAuth, {
      headers: {},
      query: { apiKey: mintPlaintext() }
    })

    assert.equal(payload.code, 'API_KEY_MISSING')
  })
})

