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
  const trimmed = query?.trim()
  return !!trimmed
}

const OPTIMIZE_PROMPT = `You are a search query optimizer for an HRMS knowledge base.
The knowledge base documents are written strictly in English.

RULES:
1. If the user query is in another language (Hindi, Spanish, etc.) or Hinglish (e.g., "leave apply kaise kare"), translate it into standard English keywords.
2. Resolve pronouns and references using the provided conversation history (if any).
3. If the query is already in clear English, keep it as is or expand acronyms/slang.
4. Add nothing that was not asked, and never answer the question.
5. Reply with the search-optimized English query and nothing else.`

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
    .replace(/^(?:rewrite|rewritten question|standalone question|question|search query)\s*:\s*/i, '')
    .replace(/^["'`*]+|["'`*]+$/g, '')
    .trim()

  if (!cleaned) return original

  const tooLong = cleaned.length > original.length * 4 + 120

  if (tooLong) return original

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
        { role: 'system', content: OPTIMIZE_PROMPT },
        {
          role: 'user',
          content: `CONVERSATION\n${transcript}\n\nUSER QUERY\n${query}`
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
