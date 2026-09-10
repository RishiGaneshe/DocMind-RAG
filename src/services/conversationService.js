import { Conversation } from '../models/Conversation.js'
import { ConversationTurn } from '../models/ConversationTurn.js'
import { llmConfig, embeddingConfig, NO_ANSWER_MESSAGE } from '../config.js'

/**
 * Fire-and-forget conversation persistence.
 *
 * Every function catches its own errors and logs them. A logging failure must
 * never propagate to the route handler and must never delay or fail a user's
 * query. The caller wraps each call in `.catch(...)` as a second safety net.
 */

/**
 * Generates a conversation title from the first question.
 * Truncated to the last complete word within 200 characters.
 */
const titleFromQuery = (query) => {
  if (!query) return null

  const trimmed = query.trim()

  if (trimmed.length <= 200) return trimmed

  const cut = trimmed.slice(0, 200)
  const lastSpace = cut.lastIndexOf(' ')

  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut) + '…'
}

/**
 * Finds an existing conversation to append to, or creates a new one.
 *
 * For widget sessions with a `sessionId`, turns within the same session land
 * in the same conversation. For dashboard queries with conversation history,
 * we always create a new conversation since the history is client-managed and
 * we have no server-side session to group against.
 */
const findOrCreateConversation = async ({
  tenantId,
  userId,
  apiKeyId,
  channel,
  sessionId,
  query
}) => {
  // Widget with a session: try to resume an existing conversation.
  if (sessionId && channel === 'widget') {
    const existing = await Conversation.findOne({
      where: { tenantId, sessionId, channel: 'widget' },
      attributes: ['id', 'turnCount']
    })

    if (existing) return existing
  }

  // No resumable session — create a new conversation.
  return await Conversation.create({
    tenantId,
    userId: userId ?? null,
    apiKeyId: apiKeyId ?? null,
    channel,
    sessionId: sessionId ?? null,
    title: titleFromQuery(query),
    turnCount: 0
  })
}

/**
 * Records a single question-answer turn.
 *
 * Called from both `api/query.js` (dashboard) and `api/publicChat.js` (widget)
 * after the response has been sent to the user. The write is fire-and-forget.
 *
 * Returns `{ conversationId, turnId }` so the route can append them to the
 * response without a second query.
 */
export const recordTurn = async ({
  tenantId,
  userId,
  apiKeyId,
  channel,
  sessionId,
  query,
  result,
  responseTimeMs,
  streamMode
}) => {
  try {
    const conversation = await findOrCreateConversation({
      tenantId,
      userId,
      apiKeyId,
      channel,
      sessionId,
      query
    })

    const turnIndex = conversation.turnCount

    const isNoAnswer =
      result.answer === NO_ANSWER_MESSAGE ||
      (result.noResults === true)

    const turn = await ConversationTurn.create({
      conversationId: conversation.id,
      tenantId,
      turnIndex,
      query,
      searchQuery: result.searchQuery ?? null,
      rewritten: result.rewritten ?? false,
      answer: result.answer ?? NO_ANSWER_MESSAGE,
      noAnswer: isNoAnswer,
      cached: result.cached ?? false,
      chunksUsed: result.chunksUsed ?? 0,
      sources: result.sources ?? [],
      citedSources: result.citedSources ?? [],
      retrievalStage: result.retrieval?.stage ?? null,
      retrievalStats: result.retrieval?.stats ?? {},
      responseTimeMs: responseTimeMs ?? null,
      streamMode: streamMode ?? false,
      llmModel: llmConfig.model,
      embeddingModel: embeddingConfig.model
    })

    // Increment turnCount on the conversation.
    await Conversation.update(
      { turnCount: turnIndex + 1 },
      { where: { id: conversation.id } }
    )

    return { conversationId: conversation.id, turnId: turn.id }
  } catch (error) {
    console.error('[CONVERSATION] failed to record turn:', error.message)
    return null
  }
}

/**
 * Lists conversations for a workspace, newest first.
 */
export const getConversations = async (tenantId, { userId, limit = 50, offset = 0 } = {}) => {
  const where = { tenantId }

  if (userId) where.userId = userId

  return await Conversation.findAndCountAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: Math.min(limit, 100),
    offset,
    attributes: [
      'id', 'channel', 'sessionId', 'title', 'turnCount', 'createdAt'
    ]
  })
}

/**
 * Loads a single conversation with all its turns, ordered by turnIndex.
 */
export const getConversationWithTurns = async (tenantId, conversationId) => {
  return await Conversation.findOne({
    where: { tenantId, id: conversationId },
    include: [{
      model: ConversationTurn,
      as: 'turns',
      attributes: [
        'id', 'turnIndex', 'query', 'searchQuery', 'rewritten',
        'answer', 'noAnswer', 'cached', 'chunksUsed', 'sources',
        'citedSources', 'retrievalStage', 'retrievalStats',
        'responseTimeMs', 'streamMode', 'llmModel', 'embeddingModel',
        'feedbackRating', 'feedbackNote', 'createdAt'
      ],
      order: [['turnIndex', 'ASC']]
    }]
  })
}
