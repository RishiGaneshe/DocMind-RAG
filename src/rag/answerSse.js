import { createAnswerFilter } from './answerStream.js'
import { NO_ANSWER_MESSAGE } from '../config.js'

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
  buildSourcesEvent = defaultSourcesEvent,
  onComplete
}) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
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

      res.end()

      if (onComplete) {
        onComplete({ answer: NO_ANSWER_MESSAGE, refused: false, result })
      }

      return
    }

    const filter = createAnswerFilter(result.sourceCount)

    const reader = result.stream.getReader()
    const decoder = new TextDecoder()

    let buffer = ''
    let upstreamDone = false
    let collectedAnswer = ''
    let clientClosed = false

    const handleClose = () => {
      clientClosed = true
      reader.cancel().catch(() => {})
    }

    res.on('close', handleClose)

    try {
      while (true) {
        if (clientClosed) break

        const { done, value } = await reader.read()

        if (done || clientClosed) break

        buffer += decoder.decode(value, { stream: true })

        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (clientClosed) break

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

            if (emitted) {
              sendSSE('chunk', { content: emitted })
              collectedAnswer += emitted
            }
          } catch {
            // A malformed delta is skipped rather than failing the stream.
          }
        }
      }

      if (!clientClosed) {
        const tail = filter.flush()

        if (tail) {
          sendSSE('chunk', { content: tail })
          collectedAnswer += tail
        }

        if (filter.refused) {
          sendSSE('chunk', { content: NO_ANSWER_MESSAGE })
        }

        sendSSE('done', { success: true })
      }
    } finally {
      res.off('close', handleClose)
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
        `${filter.refused ? ', model refused' : ''}` +
        `${clientClosed ? ', client aborted' : ''}`
    )

    if (!res.writableEnded) res.end()

    if (onComplete && !clientClosed) {
      const answer = filter.refused ? NO_ANSWER_MESSAGE : collectedAnswer

      onComplete({ answer, refused: filter.refused, result })
    }
  } catch (error) {
    console.error('Streaming error:', error)

    const isProviderError = error.provider === 'nvidia' || error.status >= 500
    const isAbort =
      error.name === 'AbortError' || error.message?.includes('aborted')

    const userMessage = isProviderError
      ? 'The AI service is temporarily unavailable. Please try again in a moment.'
      : isAbort
        ? 'The request timed out. Please try again.'
        : 'An error occurred while generating the answer.'

    sendSSE('error', {
      error: userMessage,
      retryable: isProviderError || isAbort
    })

    res.end()
  }
}
