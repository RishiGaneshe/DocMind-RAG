import test, { describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  WIDGET_DEFAULTS,
  resolveWidgetConfig,
  normaliseWidgetConfig,
  redactSources
} from '../services/widgetService.js'

/**
 * `redactSources` is the last thing standing between raw chunk text and an
 * anonymous visitor on a customer's website, so the assertions are about what is
 * *absent* from the output, not only what is present.
 */

const unredacted = [
  {
    citation: 1,
    documentId: '0d3f6d64-0f8c-4c74-9e2a-5c9c8a4a2f11',
    filename: 'internal-pricing-2026.pdf',
    chunkIndex: 7,
    page: 4,
    breadcrumb: 'internal-pricing-2026.pdf › page 4',
    relevanceScore: 0.83,
    scoreType: 'rerank',
    snippet: 'Enterprise discount floor is 38% for deals above …'
  }
]

describe('redactSources', () => {
  test('"labels" keeps only what a citation needs to render', () => {
    const [source] = redactSources(unredacted, 'labels')

    assert.deepEqual(Object.keys(source).sort(), ['citation', 'filename', 'page'])
  })

  test('"labels" withholds the chunk text, the document id and the scores', () => {
    const [source] = redactSources(unredacted, 'labels')

    assert.equal(source.snippet, undefined)
    assert.equal(source.documentId, undefined)
    assert.equal(source.relevanceScore, undefined)
    assert.equal(source.scoreType, undefined)
    assert.equal(source.chunkIndex, undefined)
    assert.equal(source.breadcrumb, undefined)
  })

  test('"labels" normalises a missing page to null rather than dropping the key', () => {
    const [source] = redactSources([{ citation: 1, filename: 'a.md' }], 'labels')

    assert.equal(source.page, null)
  })

  test('"hidden" returns nothing at all', () => {
    assert.deepEqual(redactSources(unredacted, 'hidden'), [])
  })

  test('"full" passes the internal shape through untouched', () => {
    assert.deepEqual(redactSources(unredacted, 'full'), unredacted)
  })

  test('an unknown mode falls back to redacting, not to disclosing', () => {
    const [source] = redactSources(unredacted, 'something-new')

    assert.equal(source.snippet, undefined)
  })

  test('tolerates an empty or absent list', () => {
    assert.deepEqual(redactSources([], 'full'), [])
    assert.deepEqual(redactSources(undefined, 'full'), [])
    assert.deepEqual(redactSources(null, 'labels'), [])
  })
})

describe('resolveWidgetConfig', () => {
  test('fills in every default when nothing is stored', () => {
    assert.deepEqual(resolveWidgetConfig(null), WIDGET_DEFAULTS)
    assert.deepEqual(resolveWidgetConfig(undefined), WIDGET_DEFAULTS)
    assert.deepEqual(resolveWidgetConfig({}), WIDGET_DEFAULTS)
  })

  test('overrides only the keys that were stored', () => {
    const resolved = resolveWidgetConfig({ title: 'Ask the docs' })

    assert.equal(resolved.title, 'Ask the docs')
    assert.equal(resolved.greeting, WIDGET_DEFAULTS.greeting)
    assert.equal(resolved.sourceMode, WIDGET_DEFAULTS.sourceMode)
  })

  test('ignores a stored value that is not an object', () => {
    assert.deepEqual(resolveWidgetConfig('corrupt'), WIDGET_DEFAULTS)
  })
})

describe('normaliseWidgetConfig — partial update semantics', () => {
  test('returns only the keys the caller supplied', () => {
    const { config } = normaliseWidgetConfig({ title: 'Support' })

    assert.deepEqual(config, { title: 'Support' })
  })

  test('trims the strings it keeps', () => {
    const { config } = normaliseWidgetConfig({ title: '  Support  ' })

    assert.equal(config.title, 'Support')
  })

  test('refuses an update that changes nothing recognised', () => {
    assert.ok(normaliseWidgetConfig({}).error)
    assert.ok(normaliseWidgetConfig({ unknownField: true }).error)
  })

  test('refuses a non-object body', () => {
    assert.ok(normaliseWidgetConfig(null).error)
    assert.ok(normaliseWidgetConfig([]).error)
    assert.ok(normaliseWidgetConfig('title').error)
  })
})

describe('normaliseWidgetConfig — validation', () => {
  test('bounds every string field', () => {
    assert.ok(normaliseWidgetConfig({ title: 'x'.repeat(61) }).error)
    assert.ok(normaliseWidgetConfig({ greeting: 'x'.repeat(301) }).error)
    assert.ok(normaliseWidgetConfig({ placeholder: 'x'.repeat(81) }).error)
    assert.ok(normaliseWidgetConfig({ footerNote: 'x'.repeat(121) }).error)
  })

  test('names the field that failed', () => {
    assert.match(normaliseWidgetConfig({ title: 'x'.repeat(61) }).error, /title/)
  })

  test('rejects a non-string where a string belongs', () => {
    assert.ok(normaliseWidgetConfig({ title: 42 }).error)
  })

  test('accepts up to six suggestions and drops blank ones', () => {
    const { config } = normaliseWidgetConfig({
      suggestions: ['How do I reset my password?', '   ', 'What are your hours?']
    })

    assert.deepEqual(config.suggestions, [
      'How do I reset my password?',
      'What are your hours?'
    ])
  })

  test('rejects a seventh suggestion and a non-array', () => {
    assert.ok(normaliseWidgetConfig({ suggestions: Array(7).fill('hi') }).error)
    assert.ok(normaliseWidgetConfig({ suggestions: 'hi' }).error)
  })

  test('accepts 3- and 6-digit hex colours and lower-cases them', () => {
    assert.equal(normaliseWidgetConfig({ accentColor: '#ABC' }).config.accentColor, '#abc')
    assert.equal(
      normaliseWidgetConfig({ accentColor: '#2563EB' }).config.accentColor,
      '#2563eb'
    )
  })

  test('rejects anything else in a colour field', () => {
    // A CSS colour reaches an inline style in a page this server does not own,
    // so "red" or a url() is refused rather than passed through.
    assert.ok(normaliseWidgetConfig({ accentColor: 'red' }).error)
    assert.ok(normaliseWidgetConfig({ accentColor: '2563eb' }).error)
    assert.ok(normaliseWidgetConfig({ accentColor: '#12345' }).error)
    assert.ok(normaliseWidgetConfig({ accentColor: 'url(javascript:alert(1))' }).error)
  })

  test('constrains the enumerated fields', () => {
    assert.equal(normaliseWidgetConfig({ position: 'left' }).config.position, 'left')
    assert.ok(normaliseWidgetConfig({ position: 'centre' }).error)

    assert.equal(normaliseWidgetConfig({ sourceMode: 'hidden' }).config.sourceMode, 'hidden')
    assert.ok(normaliseWidgetConfig({ sourceMode: 'everything' }).error)

    assert.equal(normaliseWidgetConfig({ showBranding: false }).config.showBranding, false)
    assert.ok(normaliseWidgetConfig({ showBranding: 'false' }).error)
  })
})

