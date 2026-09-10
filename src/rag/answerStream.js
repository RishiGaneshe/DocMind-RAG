import {
  REASONING_RESUME_MIN_CHARS,
  SENTINEL_MAX_LENGTH,
  SENTINEL_NORMALIZED,
  couldBeReasoningHead,
  findAnswerStart,
  findReasoningBoundary,
  looksLikeReasoningHead,
  normalizeForSentinel,
  scrubSourceLeaks,
  stripReasoning
} from '../services/llmService.js'

/**
 * Holds the head of the stream back just long enough to tell an answer apart
 * from the model thinking out loud. A reply that does not open like
 * deliberation is released on the first delta that rules it out — a token or
 * two — so ordinary answers stream with no added delay.
 *
 * Once deliberation is detected the gate drops content until the model marks
 * where its answer starts (`</think>`, "Final answer:", a horizontal rule) or
 * until a paragraph arrives that is plainly answer rather than plan. If
 * neither ever happens, `flush` extracts the answer from what was buffered,
 * which costs that one reply its streaming but not its content.
 */
const createReasoningGate = () => {
  let pending = ''
  let mode = 'head' // 'head' undecided → 'pass' streaming | 'drop' discarding
  let suppressed = false
  let trimming = true // The answer never opens on whitespace a boundary left.

  const trimLeading = (text) => {
    if (!trimming) return text

    const out = text.replace(/^\s+/, '')

    if (out) trimming = false

    return out
  }

  const release = () => {
    const out = pending

    pending = ''
    mode = 'pass'

    return trimLeading(out)
  }

  // Where the dropped text stops being deliberation, or -1 to keep dropping.
  // A paragraph is only judged once enough of it has arrived to judge it.
  const resumePoint = (text) => {
    const marked = findReasoningBoundary(text)

    if (marked >= 0) return marked

    const start = findAnswerStart(text)

    return start >= 0 && text.length - start >= REASONING_RESUME_MIN_CHARS
      ? start
      : -1
  }

  return {
    push(content) {
      if (mode === 'pass') return trimLeading(content)

      pending += content

      if (mode === 'head') {
        if (couldBeReasoningHead(pending)) return ''
        if (!looksLikeReasoningHead(pending)) return release()

        mode = 'drop'
        suppressed = true
      }

      const start = resumePoint(pending)

      if (start < 0) return ''

      pending = pending.slice(start)

      return release()
    },

    flush() {
      const text = pending
      const dropping = mode === 'drop'

      pending = ''
      mode = 'pass'

      if (!text) return ''
      if (!dropping && !looksLikeReasoningHead(text)) return trimLeading(text)

      suppressed = true

      return trimLeading(stripReasoning(text))
    },

    get suppressed() {
      return suppressed
    }
  }
}

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
  const reasoning = createReasoningGate()
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

  // Runs on text the reasoning gate has already cleared, so the sentinel is
  // still measured against the first characters of the real answer.
  const accept = (content) => {
    if (refused) return ''

    if (decided) return citations.push(content)

    head += content

    if (!decide(false) || refused) return ''

    return citations.push(head)
  }

  return {
    push(content) {
      const visible = reasoning.push(content)

      return visible ? accept(visible) : ''
    },

    flush() {
      const tail = reasoning.flush()
      const emitted = tail ? accept(tail) : ''

      if (refused) return ''

      if (!decided) {
        decide(true)

        if (refused) return ''

        return emitted + citations.push(head) + citations.flush()
      }

      return emitted + citations.flush()
    },

    get refused() {
      return refused
    },

    get suppressedReasoning() {
      return reasoning.suppressed
    },

    get droppedCitations() {
      return citations.droppedCount
    }
  }
}
