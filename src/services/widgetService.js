import {
  WIDGET_SOURCE_MODES,
  DEFAULT_WIDGET_SOURCE_MODE
} from '../config.js'

/**
 * Widget presentation settings, and the redaction rule that governs how much of
 * a retrieved source an anonymous visitor is shown.
 *
 * Stored as JSONB on `tenants.widgetConfig` because it is strictly 1:1 with a
 * workspace and is read on every widget bootstrap. Validated on the way in
 * rather than on the way out, so a malformed value can never reach a browser.
 */

export const WIDGET_DEFAULTS = {
  title: 'Ask us anything',
  greeting: 'Hi! Ask me anything about this site and I will answer from our documentation.',
  placeholder: 'Type your question…',
  suggestions: [],
  accentColor: '#2563eb',
  position: 'right',
  showBranding: true,
  footerNote: '',
  sourceMode: DEFAULT_WIDGET_SOURCE_MODE
}

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

export const resolveWidgetConfig = (stored) => ({
  ...WIDGET_DEFAULTS,
  ...(stored && typeof stored === 'object' ? stored : {})
})

const text = (value, { max, label }) => {
  if (typeof value !== 'string') return { error: `"${label}" must be a string` }

  const trimmed = value.trim()

  if (trimmed.length > max) {
    return { error: `"${label}" must be ${max} characters or fewer` }
  }

  return { value: trimmed }
}

/**
 * Validates a partial update. Returns `{ config }` containing only the keys the
 * caller actually supplied, so a PUT that omits a field leaves it alone rather
 * than resetting it to the default.
 */
export const normaliseWidgetConfig = (input) => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'The widget configuration must be an object' }
  }

  const config = {}

  const strings = [
    ['title', 60],
    ['greeting', 300],
    ['placeholder', 80],
    ['footerNote', 120]
  ]

  for (const [field, max] of strings) {
    if (input[field] === undefined) continue

    const result = text(input[field], { max, label: field })

    if (result.error) return { error: result.error }

    config[field] = result.value
  }

  if (input.suggestions !== undefined) {
    if (!Array.isArray(input.suggestions)) {
      return { error: '"suggestions" must be an array of strings' }
    }

    if (input.suggestions.length > 6) {
      return { error: '"suggestions" is limited to 6 entries' }
    }

    const suggestions = []

    for (const entry of input.suggestions) {
      const result = text(entry, { max: 120, label: 'suggestions' })

      if (result.error) return { error: result.error }
      if (result.value) suggestions.push(result.value)
    }

    config.suggestions = suggestions
  }

  if (input.accentColor !== undefined) {
    if (typeof input.accentColor !== 'string' || !HEX_COLOR.test(input.accentColor)) {
      return { error: '"accentColor" must be a hex colour such as #2563eb' }
    }

    config.accentColor = input.accentColor.toLowerCase()
  }

  if (input.position !== undefined) {
    if (input.position !== 'left' && input.position !== 'right') {
      return { error: '"position" must be either "left" or "right"' }
    }

    config.position = input.position
  }

  if (input.showBranding !== undefined) {
    if (typeof input.showBranding !== 'boolean') {
      return { error: '"showBranding" must be a boolean' }
    }

    config.showBranding = input.showBranding
  }

  if (input.sourceMode !== undefined) {
    if (!WIDGET_SOURCE_MODES.includes(input.sourceMode)) {
      return {
        error: `"sourceMode" must be one of: ${WIDGET_SOURCE_MODES.join(', ')}`
      }
    }

    config.sourceMode = input.sourceMode
  }

  if (Object.keys(config).length === 0) {
    return { error: 'No supported widget settings were provided' }
  }

  return { config }
}

/**
 * Strips a source list down to what the owner has agreed to expose publicly.
 *
 * The unredacted shape from `ragEngine.buildSources` carries a 240-character
 * `snippet` of raw chunk text plus the internal `documentId` and relevance
 * scores. On a public widget that leaks internal filenames and lets a caller
 * walk the corpus out 240 characters at a time, so `labels` — enough to render a
 * citation, nothing more — is the default.
 */
export const redactSources = (sources, mode) => {
  if (!Array.isArray(sources) || sources.length === 0) return []
  if (mode === 'hidden') return []
  if (mode === 'full') return sources

  return sources.map((source) => ({
    citation: source.citation,
    filename: source.filename,
    page: source.page ?? null
  }))
}
