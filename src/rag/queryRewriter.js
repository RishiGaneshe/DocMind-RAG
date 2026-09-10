import { completeText, LLM_MODEL } from '../services/llmService.js'
import {
  cacheGetJson,
  cacheSetJson,
  rewriteCacheKey
} from '../services/cacheService.js'
import { cacheConfig, llmConfig } from '../config.js'

const FOLLOW_UP_OPENER =
  /^(?:and|also|but|so|then|what about|how about|what else|anything else|ok|okay)\b/i

const BACK_REFERENCE =
  /\b(?:it|its|it's|they|them|their|theirs|that|those|these|this|he|she|him|her|his|hers|same|above|previous|latter|former)\b/i

const SHORT_QUERY_WORDS = 5

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

  const COMMON_PRONOUNS_AND_STOPWORDS = new Set([
    'they', 'them', 'their', 'theirs', 'this', 'that', 'these', 'those',
    'what', 'which', 'where', 'when', 'who', 'whom', 'whose', 'why', 'how',
    'does', 'done', 'doing', 'have', 'been', 'would', 'could', 'should',
    'about', 'there', 'here', 'some', 'more', 'also', 'with', 'from'
  ])

  const meaningfulWords = original
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3 && !COMMON_PRONOUNS_AND_STOPWORDS.has(word))

  if (meaningfulWords.length > 0) {
    const kept = meaningfulWords.filter((word) => cleaned.toLowerCase().includes(word))

    if (kept.length === 0) return original
  }

  return cleaned
}

export const rewriteQuery = async (query, history) => {
  if (!needsRewrite(query, history)) return { query, rewritten: false }

  const transcript = buildTranscript(history)
  const key = rewriteCacheKey(LLM_MODEL, transcript, query)

  if (cacheConfig.rewriteEnabled) {
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

    if (cacheConfig.rewriteEnabled) {
      await cacheSetJson(key, rewritten, cacheConfig.rewriteTtlSeconds)
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
