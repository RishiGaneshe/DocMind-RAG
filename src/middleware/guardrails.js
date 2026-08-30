/**
 * A cheap deterministic guard on the question, ahead of anything that costs
 * money.
 *
 * This is not a content-safety classifier and does not try to be. It rejects the
 * narrow class of input whose only purpose is to break the grounding contract —
 * instruction overrides, requests for the system prompt, and forged source
 * markers — because those are the ones that turn a cited answer into an
 * uncited one. Judging whether a question is *appropriate* is a different
 * problem needing a different model, and guessing at it here would reject
 * legitimate questions about documents that happen to discuss difficult topics.
 *
 * Patterns are phrase-level on purpose. A bare `ignore` or `system` appears in
 * ordinary questions about ordinary documents; `ignore all previous
 * instructions` does not.
 */

const OVERRIDE_PATTERNS = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.?!]{0,40}\b(?:previous|prior|earlier|above|all|any|your|the)\b[^.?!]{0,20}\b(?:instruction|instructions|prompt|prompts|rule|rules|direction|directions|context|constraint|constraints|guideline|guidelines)\b/i,
  /\b(?:reveal|repeat|print|show|output|display|disclose|tell me)\b[^.?!]{0,30}\b(?:your|the)\b[^.?!]{0,20}\b(?:system prompt|system message|instructions|prompt|initial prompt|rules)\b/i,
  /\byou are (?:now|no longer)\b/i,
  /\b(?:act|behave|respond|pretend|roleplay)\b[^.?!]{0,20}\bas (?:if you|though you|an unrestricted|a different|DAN)\b/i,
  /\b(?:developer|debug|god|admin|jailbreak)\s+mode\b/i,
  /\bwithout (?:citing|citations|any citations|referencing the sources)\b/i,
  /\b(?:answer|respond)\b[^.?!]{0,30}\bfrom your own knowledge\b/i
]

const FORGED_SCAFFOLD_PATTERNS = [
  /^\s*(?:system|assistant)\s*:/im,
  /\bNOT_IN_CONTEXT\b/,
  /^\s*SOURCES\s*$/im,
  /\[\s*\d+\s*\]\s*\n/
]

// C0 and C1 control characters, tab and newline excepted. Nothing legitimate
// types these; a prompt smuggled through them would not be visible in a log.
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]')

// Bidirectional overrides can make displayed text read differently from what is
// actually sent, so a query carrying them cannot be reviewed by a human.
const BIDI_OVERRIDES = new RegExp('[\\u202a-\\u202e\\u2066-\\u2069]')

const REPEATED_CHARACTER = /(.)\1{60,}/

/**
 * Returns `null` when the query is acceptable, or `{ reason, code }` describing
 * why it was refused. Pure, so the rule set can be tested without an HTTP layer.
 */
export const inspectQuery = (query) => {
  if (typeof query !== 'string') return null

  if (CONTROL_CHARACTERS.test(query)) {
    return {
      code: 'INVALID_CHARACTERS',
      reason: 'The question contains control characters. Please retype it as plain text.'
    }
  }

  if (BIDI_OVERRIDES.test(query)) {
    return {
      code: 'INVALID_CHARACTERS',
      reason:
        'The question contains bidirectional text overrides. Please retype it as plain text.'
    }
  }

  if (REPEATED_CHARACTER.test(query)) {
    return {
      code: 'DEGENERATE_QUERY',
      reason: 'The question contains a long run of repeated characters.'
    }
  }

  if (OVERRIDE_PATTERNS.some((pattern) => pattern.test(query))) {
    return {
      code: 'PROMPT_INJECTION',
      reason:
        'This question asks the assistant to set aside its instructions. ' +
        'Ask about the contents of your documents instead.'
    }
  }

  if (FORGED_SCAFFOLD_PATTERNS.some((pattern) => pattern.test(query))) {
    return {
      code: 'PROMPT_INJECTION',
      reason:
        'This question imitates the internal source formatting. ' +
        'Please ask it as ordinary prose.'
    }
  }

  return null
}

export const promptGuardrails = (req, res, next) => {
  const verdict = inspectQuery(req.body?.query)

  if (!verdict) return next()

  console.warn(
    `[GUARDRAILS] rejected a query from ${req.user?.id ?? 'anonymous'}: ${verdict.code}`
  )

  return res.status(400).json({
    success: false,
    error: verdict.reason,
    code: verdict.code
  })
}
