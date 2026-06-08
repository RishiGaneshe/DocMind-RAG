import { config } from '../config.js'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const REQUEST_TIMEOUT_MS = 60000
const MAX_RETRIES = 2

const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504]

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


const buildSystemPrompt = () => {
  return `You are DocMind, a precise document analysis assistant. Your role is to answer user questions using ONLY the provided document context.

STRICT RULES:
- Answer the question directly. Do NOT repeat the question back.
- Do NOT generate follow-up questions, self-validate your answers, or create fictional Q&A dialogues.
- Do NOT say "Based on the provided context" or similar preambles. Just answer.
- If the context does not contain sufficient information, state clearly: "The provided documents do not contain information about this topic."
- Do NOT speculate, infer beyond what is explicitly stated, or fabricate information.
- Use clear, concise language. Prefer bullet points or numbered lists for multi-part answers.
- When referencing information, naturally indicate which source it comes from (e.g., "According to the document..." or "The documentation states...").
- Keep responses focused and professional. Do not add unnecessary commentary.
- Use markdown formatting (bold, lists, headers) to improve readability when appropriate.`
}

const buildUserMessage = (query, contextChunks) => {
  const context = contextChunks
    .map((chunk, i) => `[Source ${i + 1}]\n${chunk}`)
    .join('\n\n')

  return `DOCUMENT CONTEXT:
${context}

---
USER QUESTION: ${query}

Provide a direct, accurate answer using only the document context above. Do not generate any follow-up questions or self-referential dialogue.`
}


const buildRequestBody = (query, contextChunks, stream = false) => ({
  model: GROQ_MODEL,
  messages: [
    {
      role: 'system',
      content: buildSystemPrompt()
    },
    {
      role: 'user',
      content: buildUserMessage(query, contextChunks)
    }
  ],
  temperature: 0.3,
  max_tokens: 2048,
  stream
})


const callGroq = async (query, contextChunks) => {
  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.groqApiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify(buildRequestBody(query, contextChunks, false))
    })

    if (!response.ok) {
      const errorBody = await response.text()
      const error = new Error(
        `Groq API error ${response.status}: ${errorBody}`
      )
      error.status = response.status
      throw error
    }

    const data = await response.json()

    const answer = data?.choices?.[0]?.message?.content

    if (!answer) {
      throw new Error('No answer returned from Groq')
    }

    return answer
  } finally {
    clearTimeout(timeout)
  }
}


export const generateAnswer = async (query, contextChunks) => {
  let lastError

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await callGroq(query, contextChunks)
    } catch (error) {
      lastError = error

      const shouldRetry =
        RETRYABLE_STATUS_CODES.includes(error.status)

      if (!shouldRetry || attempt === MAX_RETRIES) {
        break
      }

      const backoffMs = 1000 * Math.pow(2, attempt - 1)

      console.warn(
        `Groq attempt ${attempt} failed (${error.status}). Retrying in ${backoffMs}ms`
      )

      await sleep(backoffMs)
    }
  }

  console.error('Failed to generate answer from Groq:', lastError)
  throw lastError
}


export const generateAnswerStream = async (query, contextChunks) => {
  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.groqApiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify(buildRequestBody(query, contextChunks, true))
    })

    if (!response.ok) {
      clearTimeout(timeout)
      const errorBody = await response.text()
      const error = new Error(
        `Groq API error ${response.status}: ${errorBody}`
      )
      error.status = response.status
      throw error
    }

    return {
      stream: response.body,
      cleanup: () => clearTimeout(timeout)
    }
  } catch (error) {
    clearTimeout(timeout)
    throw error
  }
}
