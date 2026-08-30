import {
  SENTINEL_MAX_LENGTH,
  SENTINEL_NORMALIZED,
  normalizeForSentinel
} from '../services/llmService.js'

/**
 * Streams text through while validating citation markers, holding back a
 * trailing partial marker so a `[` at the end of one delta and `12]` at the
 * start of the next are judged as one token rather than emitted and then
 * contradicted.
 */
const createCitationFilter = (sourceCount) => {
  let pending = ''
  let dropped = 0

  const scrub = (text) =>
    text.replace(/\[(\d{1,3})\]/g, (marker, digits) => {
      const n = Number(digits)

      if (n >= 1 && n <= sourceCount) return marker

      dropped += 1

      return ''
    })

  return {
    push(content) {
      pending += content

      const held = pending.match(/\[\d{0,3}$/)
      const safeLength = held ? pending.length - held[0].length : pending.length

      const out = scrub(pending.slice(0, safeLength))

      pending = pending.slice(safeLength)

      return out
    },

    flush() {
      const out = scrub(pending)

      pending = ''

      return out
    },

    get droppedCount() {
      return dropped
    }
  }
}

/**
 * Applies the answer contract to a token stream.
 *
 * The refusal sentinel can only be recognised from the first few tokens, so the
 * head of the stream is held back until it either matches the sentinel or has
 * clearly diverged from it. That hold-back is at most a couple of dozen
 * characters, which is imperceptible next to the first-token latency, and it is
 * the difference between the user seeing an honest miss and seeing the raw
 * `NOT_IN_CONTEXT` marker.
 */
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
