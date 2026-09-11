import { completeText, LLM_MODEL } from '../services/llmService.js'
import {
  cacheGetJson,
  cacheSetJson,
  rewriteCacheKey
} from '../services/cacheService.js'
import { cacheConfig, llmConfig } from '../config.js'

export const needsRewrite = (query, history) => {
  if (typeof query !== 'string') return false
  return query.trim().length > 0
}

const OPTIMIZE_PROMPT = `You are a search query optimizer for an HRMS knowledge base.
The knowledge base documents are written strictly in English.

RULES:
1. If the user query is in another language (Hindi, Spanish, etc.) or Hinglish (e.g., "leave apply kaise kare"), translate it into standard English keywords.
2. Resolve pronouns and references using the provided conversation history (if any).
3. If the query is already in clear English, keep it as is or expand acronyms/slang.
4. Add nothing that was not asked, and never answer the question.
5. Do not include introductory text, explanations, or quotes.
6. Reply with the search-optimized English query and nothing else.`

const buildTranscript = (history) => {
  if (!Array.isArray(history)) return ''

  return history
    .filter(
      (turn) =>
        turn &&
        (turn.role === 'user' || turn.role === 'assistant') &&
        typeof turn.content === 'string' &&
        turn.content.trim()
    )
    .slice(-llmConfig.maxHistoryTurns)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.trim()}`)
    .join('\n')
}

const LABEL_PATTERN =
  /^\*{0,2}(?:search[- ]optimized query|search query|rewritten question|standalone question|optimized query|english query|query|rewrite|output)\*{0,2}\s*[:：]\s*(.+)$/i

const PREAMBLE_PATTERN =
  /^(?:here (?:is|are)|sure|certainly|okay|ok|below is|the (?:search|rewritten|optimized|translated) query)\b.*[:：]?$/i

export const sanitizeRewrite = (raw, original) => {
  if (typeof raw !== 'string') return original

  let cleanedRaw = raw
    .replace(/^```[a-zA-Z]*\n?/gm, '')
    .replace(/\n?```$/gm, '')
    .trim()

  if (!cleanedRaw) return original

  const lines = cleanedRaw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (lines.length === 0) return original

  let targetLine = null

  for (const line of lines) {
    const match = line.match(LABEL_PATTERN)
    if (match && match[1]?.trim()) {
      targetLine = match[1].trim()
      break
    }
  }

  if (!targetLine) {
    for (const line of lines) {
      if (!PREAMBLE_PATTERN.test(line)) {
        targetLine = line
        break
      }
    }
  }

  if (!targetLine) {
    targetLine = lines[0]
  }

  let cleaned = targetLine
    .replace(LABEL_PATTERN, '$1')
    .replace(
      /^(?:search[- ]optimized query|search query|rewritten question|standalone question|optimized query|english query|query|rewrite|output)\s*[:：]\s*/i,
      ''
    )
    .replace(/^["'`*]+|["'`*]+$/g, '')
    .trim()

  if (!cleaned) return original

  const originalLength = typeof original === 'string' ? original.trim().length : 0
  const maxAllowedLength = Math.max(originalLength * 4 + 120, 300)

  if (cleaned.length > maxAllowedLength) return original

  return cleaned
}

export const rewriteQuery = async (query, history) => {
  if (!needsRewrite(query, history)) return { query, rewritten: false }

  const trimmedQuery = query.trim()
  const transcript = buildTranscript(history)
  const key = rewriteCacheKey(LLM_MODEL, transcript, trimmedQuery)

  if (cacheConfig.rewriteEnabled) {
    const cached = await cacheGetJson(key)

    if (typeof cached === 'string' && cached.trim()) {
      return { query: cached, rewritten: cached !== trimmedQuery }
    }
  }

  const userContent = transcript
    ? `CONVERSATION\n${transcript}\n\nUSER QUERY\n${trimmedQuery}`
    : `USER QUERY\n${trimmedQuery}`

  try {
    const raw = await completeText(
      [
        { role: 'system', content: OPTIMIZE_PROMPT },
        {
          role: 'user',
          content: userContent
        }
      ],
      { maxTokens: 160, temperature: 0 }
    )

    if (!raw || typeof raw !== 'string' || !raw.trim()) {
      return { query: trimmedQuery, rewritten: false }
    }

    const rewritten = sanitizeRewrite(raw, trimmedQuery)

    if (cacheConfig.rewriteEnabled && rewritten) {
      await cacheSetJson(key, rewritten, cacheConfig.rewriteTtlSeconds)
    }

    if (rewritten !== trimmedQuery) {
      console.log(`[REWRITE] "${trimmedQuery}" -> "${rewritten}"`)
    }

    return { query: rewritten, rewritten: rewritten !== trimmedQuery }
  } catch (error) {
    console.warn(`[REWRITE] failed, using the original query: ${error.message}`)

    return { query: trimmedQuery, rewritten: false }
  }
}
