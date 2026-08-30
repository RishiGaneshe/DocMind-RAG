import { completeText, LLM_MODEL } from '../services/llmService.js'
import {
  cacheGetJson,
  cacheSetJson,
  rewriteCacheKey
} from '../services/cacheService.js'
import { cacheConfig, llmConfig } from '../config.js'

/**
 * Openers that only make sense as a continuation, and back-references that need
 * an antecedent. `there` is deliberately absent: `is there a retention policy`
 * is a perfectly standalone question and would trip the gate on every turn.
 */
const FOLLOW_UP_OPENER =
  /^(?:and|also|but|so|then|what about|how about|what else|anything else|ok|okay)\b/i

const BACK_REFERENCE =
  /\b(?:it|its|it's|they|them|their|theirs|that|those|these|this|he|she|him|her|his|hers|same|above|previous|latter|former)\b/i

const SHORT_QUERY_WORDS = 5

/**
 * Whether the query looks like it depends on the conversation.
 *
 * A gate rather than an unconditional rewrite: rewriting every question would
 * add an LLM round trip to every request, and a self-contained question gains
 * nothing from it. Cheap to be wrong in either direction — a missed rewrite
 * degrades to the current behaviour and a needless one returns the query intact.
 */
export const needsRewrite = (query, history) => {
  if (!Array.isArray(history) || history.length === 0) return false

  const trimmed = query.trim()

  if (!trimmed) return false

  return (
    FOLLOW_UP_OPENER.test(trimmed) ||
    BACK_REFERENCE.test(trimmed) ||
    trimmed.split(/\s+/).length < SHORT_QUERY_WORDS
  )
}

const REWRITE_PROMPT = `You rewrite a follow-up question so it can be understood on its own.

RULES
1. Resolve pronouns and references using the conversation.
2. Keep the user's wording, and reproduce names, figures and identifiers exactly.
3. Add nothing that was not asked, and never answer the question.
4. If the question already stands alone, repeat it unchanged.
5. Reply with the rewritten question and nothing else.

EXAMPLE
Conversation: user asked about the audit log retention period; the answer was 90 days.
Follow-up: what about debug logs?
Rewrite: What is the retention period for debug logs?`

const buildTranscript = (history) =>
  history
    .slice(-llmConfig.maxHistoryTurns)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
    .join('\n')

/**
 * Accepts a rewrite only if it still looks like the same question asked plainly.
 *
 * A small instruct model will occasionally answer the question instead of
 * rewriting it, or wrap the rewrite in `Rewrite:` or quotes. The wrappers are
 * cheap to strip; anything that grew into prose is rejected outright, because
 * retrieving against a hallucinated answer is worse than retrieving against a
 * vague question.
 */
export const sanitizeRewrite = (raw, original) => {
  if (typeof raw !== 'string') return original

  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  if (!firstLine) return original

  const cleaned = firstLine
    .replace(/^(?:rewrite|rewritten question|standalone question|question)\s*:\s*/i, '')
    .replace(/^["'`*]+|["'`*]+$/g, '')
    .trim()

  if (!cleaned) return original

  const tooLong = cleaned.length > original.length * 4 + 120

  if (tooLong) return original

  // A rewrite that has dropped every word of the original is not a rewrite.
  const words = new Set(
    original
      .toLowerCase()
      .split(/\W+/)
      .filter((word) => word.length > 3)
  )

  if (words.size > 0) {
    const kept = [...words].filter((word) => cleaned.toLowerCase().includes(word))

    if (kept.length === 0) return original
  }

  return cleaned
}

/**
 * Returns a standalone form of `query`, or `query` itself when no rewrite is
 * needed or the attempt fails. Never throws: a broken rewrite must not be able
 * to fail a question that would otherwise have been answered.
 */
export const rewriteQuery = async (query, history) => {
  if (!needsRewrite(query, history)) return { query, rewritten: false }

  const transcript = buildTranscript(history)
  const key = rewriteCacheKey(LLM_MODEL, transcript, query)

  if (cacheConfig.rerankEnabled) {
    const cached = await cacheGetJson(key)

    if (typeof cached === 'string') {
      return { query: cached, rewritten: cached !== query }
    }
  }

  try {
    const raw = await completeText(
      [
        { role: 'system', content: REWRITE_PROMPT },
        {
          role: 'user',
          content: `CONVERSATION\n${transcript}\n\nFOLLOW-UP\n${query}`
        }
      ],
      { maxTokens: 96, temperature: 0 }
    )

    const rewritten = sanitizeRewrite(raw, query)

    if (cacheConfig.rerankEnabled) {
      await cacheSetJson(key, rewritten, cacheConfig.rerankTtlSeconds)
    }

    if (rewritten !== query) {
      console.log(`[REWRITE] "${query}" -> "${rewritten}"`)
    }

    return { query: rewritten, rewritten: rewritten !== query }
  } catch (error) {
    console.warn(`[REWRITE] failed, using the original query: ${error.message}`)

    return { query, rewritten: false }
  }
}
