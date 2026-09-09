import { createAnswerFilter } from './answerStream.js'
import { NO_ANSWER_MESSAGE } from '../config.js'

/**
 * The SSE relay shared by the dashboard query route and the public widget route.
 *
 * Extracted rather than duplicated because the fragile part is not the HTTP
 * plumbing but the answer contract enforced on the way out: the refusal sentinel
 * has to be swapped for user-facing prose, and citation markers have to be
 * stripped so retrieval numbering never reaches the visitor. Two copies of that
 * would drift, and the copy that drifted would be the public one.
 *
 * `buildSourcesEvent` is the only seam. The public route uses it to redact the
 * source list before it reaches an anonymous visitor.
 *
 * `produce` is a thunk rather than an already-resolved result so that the
 * response headers go out first and a retrieval failure surfaces as an SSE
 * `error` event on an open stream. Resolving it before `writeHead` would let the
 * route answer with an HTTP error code instead, which reads better but would
 * change the contract clients are already written against.
 */

const defaultSourcesEvent = (result) => ({
  sources: result.sources,
  query: result.query,
  searchQuery: result.searchQuery,
  rewritten: result.rewritten,
  chunksUsed: result.chunksUsed || 0
})

export const streamAnswer = async ({
  res,
  produce,
  logLabel,
  buildSourcesEvent = defaultSourcesEvent
}) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which holds every token until
    // the answer is complete and defeats the point of streaming.
    'X-Accel-Buffering': 'no'
  })

  const sendSSE = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const result = await produce()

    sendSSE('sources', buildSourcesEvent(result))

    if (result.noResults) {
      sendSSE('chunk', { content: NO_ANSWER_MESSAGE })
      sendSSE('done', { success: true })

      console.log(`${logLabel}: no results (${result.retrieval?.stage})`)

      return res.end()
    }

    const filter = createAnswerFilter(result.sourceCount)

    const reader = result.stream.getReader()
    const decoder = new TextDecoder()

    let buffer = ''
    let upstreamDone = false

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()

          if (!trimmed || !trimmed.startsWith('data: ')) continue

          const payload = trimmed.slice(6)

          if (payload === '[DONE]') {
            upstreamDone = true
            continue
          }

          try {
            const content = JSON.parse(payload)?.choices?.[0]?.delta?.content

            if (!content) continue

            const emitted = filter.push(content)

            if (emitted) sendSSE('chunk', { content: emitted })
          } catch {
            // A malformed delta is skipped rather than failing the stream.
          }
        }
      }

      const tail = filter.flush()

      if (tail) sendSSE('chunk', { content: tail })

      if (filter.refused) {
        sendSSE('chunk', { content: NO_ANSWER_MESSAGE })
      }

      sendSSE('done', { success: true })
    } finally {
      reader.releaseLock()
      result.cleanup()
    }

    if (filter.droppedCitations > 0) {
      console.warn(`${logLabel}: dropped ${filter.droppedCitations} out-of-range citation(s)`)
    }

    console.log(
      `${logLabel}: streamed ${result.chunksUsed} chunks, ` +
        `stage=${result.retrieval?.stage}` +
        `${upstreamDone ? '' : ', upstream ended without [DONE]'}` +
        `${filter.refused ? ', model refused' : ''}`
    )

    res.end()
  } catch (error) {
    console.error('Streaming error:', error)

    sendSSE('error', {
      error: 'An error occurred while generating the answer.'
    })

    res.end()
  }
}
