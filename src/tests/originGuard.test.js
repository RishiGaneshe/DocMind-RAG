import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseOriginPattern,
  normaliseOrigins,
  requestOrigin,
  originAllowed,
  originGuard
} from '../middleware/originGuard.js'

/**
 * The allowlist is the only thing standing between a lifted public key and a
 * widget embedded on someone else's site, so the near-miss cases matter more
 * than the happy path: `evil-acme.com` against `*.acme.com` is the mistake that
 * would actually be exploited.
 */

const runGuard = (apiKey, headers = {}) => {
  const req = { apiKey, headers }

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

  originGuard(req, res, () => {
    nextCalled = true
  })

  return { nextCalled, status, payload, clientOrigin: req.clientOrigin }
}

describe('parseOriginPattern — accepts', () => {
  test('a plain https origin', () => {
    const parsed = parseOriginPattern('https://acme.com')

    assert.equal(parsed.error, undefined)
    assert.equal(parsed.origin, 'https://acme.com')
    assert.equal(parsed.wildcard, false)
    assert.equal(parsed.base, 'acme.com')
  })

  test('a subdomain wildcard', () => {
    const parsed = parseOriginPattern('https://*.acme.com')

    assert.equal(parsed.error, undefined)
    assert.equal(parsed.wildcard, true)
    assert.equal(parsed.base, 'acme.com')
  })

  test('and lower-cases the host and drops the default port', () => {
    assert.equal(parseOriginPattern('https://ACME.com:443').origin, 'https://acme.com')
  })

  test('but keeps a non-default port, because the browser sends it', () => {
    assert.equal(
      parseOriginPattern('https://acme.com:8443').origin,
      'https://acme.com:8443'
    )
  })

  test('plain http on loopback, so local development works', () => {
    assert.equal(
      parseOriginPattern('http://localhost:5173').origin,
      'http://localhost:5173'
    )
    assert.equal(parseOriginPattern('http://127.0.0.1:3000').error, undefined)
  })
})

describe('parseOriginPattern — rejects', () => {
  const rejected = [
    ['acme.com', 'no scheme'],
    ['ftp://acme.com', 'wrong scheme'],
    ['https://acme.com/widget', 'a path'],
    ['https://user:secret@acme.com', 'embedded credentials'],
    ['https://a.*.acme.com', 'a wildcard that is not the leftmost label'],
    ['https://*.com', 'a wildcard over a whole suffix'],
    ['http://acme.com', 'plain http off loopback'],
    ['', 'the empty string'],
    ['   ', 'whitespace']
  ]

  for (const [value, why] of rejected) {
    test(`${JSON.stringify(value)} — ${why}`, () => {
      const parsed = parseOriginPattern(value)

      assert.ok(parsed.error, `expected an error for ${JSON.stringify(value)}`)
      assert.equal(parsed.origin, undefined)
    })
  }

  test('a non-string', () => {
    assert.ok(parseOriginPattern(42).error)
    assert.ok(parseOriginPattern(null).error)
    assert.ok(parseOriginPattern(undefined).error)
  })
})

describe('normaliseOrigins', () => {
  test('treats an absent list as unrestricted rather than invalid', () => {
    assert.deepEqual(normaliseOrigins(undefined), { origins: [] })
    assert.deepEqual(normaliseOrigins(null), { origins: [] })
  })

  test('rejects a non-array', () => {
    assert.ok(normaliseOrigins('https://acme.com').error)
  })

  test('de-duplicates after normalisation', () => {
    const result = normaliseOrigins([
      'https://acme.com',
      'https://ACME.com',
      'https://acme.com:443'
    ])

    assert.deepEqual(result.origins, ['https://acme.com'])
  })

  test('names the offending entry rather than failing generically', () => {
    const result = normaliseOrigins(['https://acme.com', 'not-an-origin'])

    assert.ok(result.error.includes('not-an-origin'))
    assert.equal(result.origins, undefined)
  })

  test('bounds the list length', () => {
    const many = Array.from({ length: 200 }, (_, i) => `https://site${i}.com`)

    assert.ok(normaliseOrigins(many).error)
  })
})

describe('originAllowed', () => {
  test('an empty allowlist permits anything, including no origin at all', () => {
    assert.equal(originAllowed('https://anywhere.com', []), true)
    assert.equal(originAllowed(null, []), true)
    assert.equal(originAllowed(null, undefined), true)
  })

  test('a non-empty allowlist refuses a request with no origin', () => {
    assert.equal(originAllowed(null, ['https://acme.com']), false)
  })

  test('matches an exact origin', () => {
    assert.equal(originAllowed('https://acme.com', ['https://acme.com']), true)
  })

  test('scheme and port are part of the identity', () => {
    assert.equal(originAllowed('http://acme.com', ['https://acme.com']), false)
    assert.equal(originAllowed('https://acme.com:8443', ['https://acme.com']), false)
    assert.equal(originAllowed('https://acme.com', ['https://acme.com:8443']), false)
  })

  test('a wildcard matches subdomains at any depth', () => {
    assert.equal(originAllowed('https://app.acme.com', ['https://*.acme.com']), true)
    assert.equal(originAllowed('https://a.b.acme.com', ['https://*.acme.com']), true)
  })

  test('a wildcard does not match the bare apex — that must be listed', () => {
    assert.equal(originAllowed('https://acme.com', ['https://*.acme.com']), false)
    assert.equal(
      originAllowed('https://acme.com', ['https://*.acme.com', 'https://acme.com']),
      true
    )
  })

  test('a lookalike domain cannot satisfy a wildcard', () => {
    assert.equal(originAllowed('https://evil-acme.com', ['https://*.acme.com']), false)
    assert.equal(originAllowed('https://acme.com.evil.io', ['https://*.acme.com']), false)
  })

  test('an unparseable candidate is refused rather than thrown on', () => {
    assert.equal(originAllowed('not-a-url', ['https://acme.com']), false)
  })

  test('an invalid stored pattern fails closed instead of matching everything', () => {
    assert.equal(originAllowed('https://acme.com', ['garbage']), false)
  })
})

describe('requestOrigin', () => {
  test('prefers the Origin header', () => {
    assert.equal(
      requestOrigin({ headers: { origin: 'https://acme.com', referer: 'https://other.com/' } }),
      'https://acme.com'
    )
  })

  test('normalises to an origin, discarding anything after the host', () => {
    assert.equal(
      requestOrigin({ headers: { referer: 'https://acme.com/docs/page?q=1#top' } }),
      'https://acme.com'
    )
  })

  test('treats the literal string "null" as no origin', () => {
    assert.equal(requestOrigin({ headers: { origin: 'null' } }), null)
  })

  test('falls back to Referer when Origin is absent', () => {
    assert.equal(
      requestOrigin({ headers: { origin: 'null', referer: 'https://acme.com/x' } }),
      'https://acme.com'
    )
  })

  test('returns null when there is nothing to read', () => {
    assert.equal(requestOrigin({ headers: {} }), null)
    assert.equal(requestOrigin({ headers: { origin: 'garbage' } }), null)
  })
})

describe('originGuard', () => {
  const publicKey = {
    type: 'public',
    keyPrefix: 'pk_live_abc123',
    allowedOrigins: ['https://acme.com', 'https://*.acme.com']
  }

  test('refuses to run before the key is resolved', () => {
    const { status, nextCalled } = runGuard(undefined)

    assert.equal(status, 500)
    assert.equal(nextCalled, false)
  })

  test('exempts secret keys — there is no browser to protect', () => {
    const { nextCalled } = runGuard(
      { type: 'secret', keyPrefix: 'sk_live_abc123', allowedOrigins: ['https://acme.com'] },
      { origin: 'https://somewhere-else.com' }
    )

    assert.equal(nextCalled, true)
  })

  test('exempts a public key with no allowlist', () => {
    const { nextCalled } = runGuard(
      { type: 'public', keyPrefix: 'pk_live_abc123', allowedOrigins: [] },
      {}
    )

    assert.equal(nextCalled, true)
  })

  test('rejects a restricted key on a request that identifies no site', () => {
    const { status, payload, nextCalled } = runGuard(publicKey, {})

    assert.equal(status, 403)
    assert.equal(payload.code, 'ORIGIN_REQUIRED')
    assert.equal(nextCalled, false)
  })

  test('rejects an origin that is not on the list', () => {
    const { status, payload } = runGuard(publicKey, { origin: 'https://evil-acme.com' })

    assert.equal(status, 403)
    assert.equal(payload.code, 'ORIGIN_NOT_ALLOWED')
  })

  test('admits a listed origin and records it', () => {
    const { nextCalled, clientOrigin } = runGuard(publicKey, {
      origin: 'https://docs.acme.com'
    })

    assert.equal(nextCalled, true)
    assert.equal(clientOrigin, 'https://docs.acme.com')
  })
})

