import { publicApiConfig } from '../config.js'

/**
 * Origin allowlisting for public keys.
 *
 * What this buys and what it does not: browsers set `Origin` on cross-origin
 * requests and page JavaScript cannot forge it, so this stops someone lifting a
 * key out of a bundle and embedding the widget on their own site. It does not
 * stop `curl`, which can send any `Origin` it likes. The daily quota is what
 * bounds a determined direct caller; this bounds the easy case.
 *
 * Patterns are compared as normalised origins — scheme, host and non-default
 * port — because that is exactly the granularity the browser reports. Comparing
 * anything finer would be comparing against a value the browser never sends.
 */

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const isLoopback = (hostname) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')

/**
 * Parses one allowlist entry into `{ origin, wildcard, base }`, or returns
 * `{ error }`. Pure, so the rule set is testable without an HTTP layer.
 */
export const parseOriginPattern = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { error: 'An origin must be a non-empty string' }
  }

  const trimmed = raw.trim()

  if (!/^https?:\/\//i.test(trimmed)) {
    return {
      error: `"${trimmed}" must start with http:// or https://`
    }
  }

  let url

  try {
    url = new URL(trimmed)
  } catch {
    return { error: `"${trimmed}" is not a valid origin` }
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    return {
      error: `"${trimmed}" must be an origin only — no path, query or fragment`
    }
  }

  if (url.username || url.password) {
    return { error: `"${trimmed}" must not contain credentials` }
  }

  const hostname = url.hostname.toLowerCase()
  const wildcard = hostname.startsWith('*.')

  if (hostname.includes('*') && !wildcard) {
    return {
      error: `"${trimmed}" may only use a wildcard as the leftmost label, as in https://*.example.com`
    }
  }

  const base = wildcard ? hostname.slice(2) : hostname

  if (base.includes('*')) {
    return { error: `"${trimmed}" may contain only one wildcard` }
  }

  // `https://*.com` would hand the key to every site on the internet under that
  // suffix. Requiring two labels does not make this a public-suffix-aware check,
  // but it removes the version of the mistake that is trivially catastrophic.
  if (wildcard && base.split('.').filter(Boolean).length < 2) {
    return { error: `"${trimmed}" is too broad — wildcard a domain you own` }
  }

  if (
    url.protocol === 'http:' &&
    !isLoopback(base) &&
    !publicApiConfig.allowInsecureOrigins
  ) {
    return {
      error:
        `"${trimmed}" is plain http. Use https, or set ` +
        'PUBLIC_ALLOW_INSECURE_ORIGINS=true if this is deliberate.'
    }
  }

  const port = url.port ? `:${url.port}` : ''

  return {
    origin: `${url.protocol}//${hostname}${port}`,
    wildcard,
    base,
    protocol: url.protocol,
    port
  }
}

/**
 * Validates and de-duplicates a whole allowlist. Returns `{ origins }` or
 * `{ error }` naming the first entry that failed, so the dashboard can point at
 * the offending row rather than saying "invalid input".
 */
export const normaliseOrigins = (value) => {
  if (value === undefined || value === null) return { origins: [] }

  if (!Array.isArray(value)) {
    return { error: '"allowedOrigins" must be an array of origin strings' }
  }

  if (value.length > publicApiConfig.maxOriginsPerKey) {
    return {
      error: `"allowedOrigins" is limited to ${publicApiConfig.maxOriginsPerKey} entries`
    }
  }

  const origins = []

  for (const entry of value) {
    const parsed = parseOriginPattern(entry)

    if (parsed.error) return { error: parsed.error }

    if (!origins.includes(parsed.origin)) origins.push(parsed.origin)
  }

  return { origins }
}

/**
 * The origin the request actually came from.
 *
 * `Origin` is the authority. `Referer` is consulted only as a fallback, for the
 * handful of browser and proxy combinations that strip `Origin` on same-site
 * requests; its path is discarded. A request with neither is not a browser
 * request.
 */
export const requestOrigin = (req) => {
  const header = req.headers.origin

  if (header && header !== 'null') {
    try {
      return new URL(header).origin
    } catch {
      return null
    }
  }

  const referer = req.headers.referer

  if (referer) {
    try {
      return new URL(referer).origin
    } catch {
      return null
    }
  }

  return null
}

/**
 * Whether `origin` satisfies any entry in `patterns`.
 *
 * A wildcard entry matches subdomains only. `https://*.acme.com` deliberately
 * does not match `https://acme.com`: an owner who wants the apex lists it, and
 * the alternative would silently widen every wildcard by one host.
 */
export const originAllowed = (origin, patterns) => {
  if (!Array.isArray(patterns) || patterns.length === 0) return true
  if (!origin) return false

  let candidate

  try {
    candidate = new URL(origin)
  } catch {
    return false
  }

  const hostname = candidate.hostname.toLowerCase()
  const port = candidate.port ? `:${candidate.port}` : ''

  return patterns.some((pattern) => {
    const parsed = parseOriginPattern(pattern)

    if (parsed.error) return false
    if (parsed.protocol !== candidate.protocol) return false
    if (parsed.port !== port) return false

    if (!parsed.wildcard) return parsed.base === hostname

    // Suffix match on a dot-prefixed base, so `evil-acme.com` cannot satisfy
    // `*.acme.com` and neither can the bare apex.
    return hostname.endsWith(`.${parsed.base}`) && hostname !== parsed.base
  })
}

/**
 * Enforces the allowlist for the key already resolved onto `req.apiKey`.
 *
 * Secret keys are exempt: they are used server-to-server, where there is no
 * `Origin` to check and no browser to protect.
 */
export const originGuard = (req, res, next) => {
  const key = req.apiKey

  if (!key) {
    return res.status(500).json({
      success: false,
      error: 'Origin guard ran before key resolution'
    })
  }

  if (key.type === 'secret' || key.allowedOrigins.length === 0) return next()

  const origin = requestOrigin(req)

  if (!origin) {
    console.warn(`[ORIGIN] ${key.keyPrefix}: request carried no Origin or Referer`)

    return res.status(403).json({
      success: false,
      error:
        'This key is restricted to specific websites and the request did not ' +
        'identify one.',
      code: 'ORIGIN_REQUIRED'
    })
  }

  if (!originAllowed(origin, key.allowedOrigins)) {
    console.warn(`[ORIGIN] ${key.keyPrefix}: rejected ${origin}`)

    return res.status(403).json({
      success: false,
      error: `This key is not authorised for ${origin}.`,
      code: 'ORIGIN_NOT_ALLOWED'
    })
  }

  req.clientOrigin = origin

  next()
}
