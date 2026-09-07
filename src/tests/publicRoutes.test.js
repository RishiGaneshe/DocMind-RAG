import test, { describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'

import publicChatRoutes from '../api/publicChat.js'
import apiKeyRoutes from '../api/apiKeys.js'
import widgetRoutes from '../api/widget.js'
import { errorHandler } from '../middleware/errorHandler.js'

/**
 * The routers mounted on a real HTTP server, exercised over the wire.
 *
 * The unit tests cover the rules; these cover the wiring the rules depend on —
 * that the CORS preflight is answered at all, that the 32kb ceiling is the one
 * in force on this router rather than the app's 1mb, and above all that the
 * order of the middleware chain puts authentication ahead of anything that
 * costs money. None of it needs Postgres or Redis, because every request here
 * is supposed to die at the key check.
 */

let base
let server

before(async () => {
  const app = express()

  // Matches app.js: the public router mounts first and brings its own CORS and
  // body parser, and `trust proxy` is what makes req.ip the visitor rather than
  // the load balancer.
  app.set('trust proxy', 1)
  app.use('/api/public', publicChatRoutes)
  app.use('/api/tenants/:tenantId/api-keys', apiKeyRoutes)
  app.use('/api/tenants/:tenantId/widget', widgetRoutes)
  app.use(errorHandler)

  server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

after(() => {
  server?.close()
})

const TENANT = '11111111-1111-1111-1111-111111111111'

describe('the widget preflight', () => {
  let preflight

  before(async () => {
    preflight = await fetch(`${base}/api/public/chat`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://customer-site.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-api-key'
      }
    })
  })

  test('is answered for an origin this server has never heard of', () => {
    // A widget is embedded on customer sites whose origins cannot be enumerated
    // in advance, so the preflight has to pass and `originGuard` — which runs
    // after the key is known — has to be the real check.
    assert.equal(preflight.status, 204)
    assert.equal(
      preflight.headers.get('access-control-allow-origin'),
      'https://customer-site.example'
    )
  })

  test('permits the key header', () => {
    assert.match(preflight.headers.get('access-control-allow-headers'), /x-api-key/i)
  })

  test('never permits credentials', () => {
    // A widget on a third-party page must not be able to make the visitor's
    // browser attach cookies to this API.
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null)
  })

  test('exposes the rate-limit headers, so a widget can back off', () => {
    const exposed = preflight.headers.get('access-control-expose-headers')

    assert.match(exposed, /ratelimit-remaining/i)
    assert.match(exposed, /retry-after/i)
  })
})

describe('a request with no usable key', () => {
  test('GET /config is 401 and names the header to send', async () => {
    const response = await fetch(`${base}/api/public/config`)
    const body = await response.json()

    assert.equal(response.status, 401)
    assert.equal(body.code, 'API_KEY_MISSING')
    assert.match(body.error, /X-Api-Key/)
  })

  test('POST /chat with a malformed key is INVALID, not MISSING', async () => {
    const response = await fetch(`${base}/api/public/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'nonsense' },
      body: JSON.stringify({ query: 'hello' })
    })
    const body = await response.json()

    assert.equal(response.status, 401)
    assert.equal(body.code, 'API_KEY_INVALID')
  })

  test('a valid-looking body does not buy a pass', async () => {
    // Authentication runs before validation, so a perfectly formed request with
    // no key is still 401 rather than 400 — the failure a caller sees first is
    // the one that matters.
    const response = await fetch(`${base}/api/public/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'What is the refund window?', stream: false })
    })
    const body = await response.json()

    assert.equal(response.status, 401)
    assert.equal(body.code, 'API_KEY_MISSING')
  })
})

describe('the public body ceiling', () => {
  test('a body past 32kb is refused before anything reads it', async () => {
    // The parse happens before the key is known, so it is the one cost an
    // unauthenticated caller can impose. The dashboard's 1mb would make that
    // cost 32 times larger.
    const response = await fetch(`${base}/api/public/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(64 * 1024) })
    })

    assert.equal(response.status, 413)
  })

  test('a body inside the ceiling reaches the key check', async () => {
    const response = await fetch(`${base}/api/public/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x'.repeat(2000) })
    })

    assert.equal(response.status, 401)
  })
})

describe('the owner-facing routes are not reachable with a widget key', () => {
  test('key management demands a bearer token', async () => {
    const response = await fetch(`${base}/api/tenants/${TENANT}/api-keys`)

    assert.equal(response.status, 401)
  })

  test('key management ignores X-Api-Key entirely', async () => {
    // The two credentials are not interchangeable: a public key must never be
    // able to mint another key or read the key list.
    const response = await fetch(`${base}/api/tenants/${TENANT}/api-keys`, {
      headers: { 'X-Api-Key': `pk_live_${'a'.repeat(43)}` }
    })

    assert.equal(response.status, 401)
  })

  test('widget settings demand a bearer token', async () => {
    const response = await fetch(`${base}/api/tenants/${TENANT}/widget`)

    assert.equal(response.status, 401)
  })

  test('writing widget settings demands a bearer token', async () => {
    const response = await fetch(`${base}/api/tenants/${TENANT}/widget`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hijacked' })
    })

    assert.equal(response.status, 401)
  })
})
