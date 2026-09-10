import { publicApiConfig } from '../config.js'

// Origin allowlisting for public keys

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

const isLoopback = (hostname) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')

// Parse allowlist entry into { origin, wildcard, base }
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

// Validate and deduplicate origins list
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

// Extract origin from request headers
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

// Check if origin matches allowed patterns
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

    return hostname.endsWith(`.${parsed.base}`) && hostname !== parsed.base
  })
}

// Enforce origin allowlist for API key
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
