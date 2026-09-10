import {
  SENTINEL_MAX_LENGTH,
  SENTINEL_NORMALIZED,
  normalizeForSentinel,
  scrubSourceLeaks
} from '../services/llmService.js'

const createCitationFilter = (sourceCount) => {
  let pending = ''
  let dropped = 0

  const scrub = (text) =>
    text
      .replace(/\[(\d{1,3})\]/g, (_marker, digits) => {
        const n = Number(digits)

        if (n < 1 || n > sourceCount) dropped += 1

        return ''
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/[ \t]+([.,;:!?])/g, '$1')

  return {
    push(content) {
      pending += content

      const held = pending.match(/\s*\[\d{0,3}$/)
      const safeLength = held ? pending.length - held[0].length : pending.length

      const out = scrubSourceLeaks(scrub(pending.slice(0, safeLength)))

      pending = pending.slice(safeLength)

      return out
    },

    flush() {
      const out = scrubSourceLeaks(scrub(pending))

      pending = ''

      return out
    },

    get droppedCount() {
      return dropped
    }
  }
}

export const createAnswerFilter = (sourceCount) => {
  const citations = createCitationFilter(sourceCount)

  let head = ''
  let decided = false
  let refused = false

  const decide = (force) => {
    const normalized = normalizeForSentinel(head)

    if (normalized.startsWith(SENTINEL_NORMALIZED)) {
      decided = true
      refused = true

      return true
    }

    const stillPossible =
      SENTINEL_NORMALIZED.startsWith(normalized) &&
      head.length < SENTINEL_MAX_LENGTH

    if (force || !stillPossible) {
      decided = true

      return true
    }

    return false
  }

  return {
    push(content) {
      if (refused) return ''

      if (decided) return citations.push(content)

      head += content

      if (!decide(false) || refused) return ''

      return citations.push(head)
    },

    flush() {
      if (refused) return ''

      if (!decided) {
        decide(true)

        if (refused) return ''

        return citations.push(head) + citations.flush()
      }

      return citations.flush()
    },

    get refused() {
      return refused
    },

    get droppedCitations() {
      return citations.droppedCount
    }
  }
}
