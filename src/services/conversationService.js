import { sequelize } from '../services/db.js'
import { Conversation } from '../models/Conversation.js'
import { ConversationTurn } from '../models/ConversationTurn.js'
import { llmConfig, embeddingConfig, NO_ANSWER_MESSAGE } from '../config.js'

const titleFromQuery = (query) => {
  if (!query) return null

  const trimmed = query.trim()

  if (trimmed.length <= 200) return trimmed

  const cut = trimmed.slice(0, 200)
  const lastSpace = cut.lastIndexOf(' ')

  return (lastSpace > 80 ? cut.slice(0, lastSpace) : cut) + '…'
}

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
    return await sequelize.transaction(async (t) => {
      let conversation

      if (sessionId && channel === 'widget') {
        conversation = await Conversation.findOne({
          where: { tenantId, sessionId, channel: 'widget' },
          transaction: t,
          lock: t.LOCK.UPDATE
        })
      }

      if (!conversation) {
        try {
          conversation = await Conversation.create(
            {
              tenantId,
              userId: userId ?? null,
              apiKeyId: apiKeyId ?? null,
              channel,
              sessionId: sessionId ?? null,
              title: titleFromQuery(query),
              turnCount: 0
            },
            { transaction: t }
          )
        } catch (err) {
          if (sessionId && channel === 'widget') {
            conversation = await Conversation.findOne({
              where: { tenantId, sessionId, channel: 'widget' },
              transaction: t,
              lock: t.LOCK.UPDATE
            })
          }
          if (!conversation) throw err
        }
      }

      const turnIndex = conversation.turnCount

      const isNoAnswer =
        result.answer === NO_ANSWER_MESSAGE || result.noResults === true

      const turn = await ConversationTurn.create(
        {
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
        },
        { transaction: t }
      )

      await conversation.increment('turnCount', { by: 1, transaction: t })

      return { conversationId: conversation.id, turnId: turn.id }
    })
  } catch (error) {
    console.error('[CONVERSATION] failed to record turn:', error.message)
    return null
  }
}

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
      ]
    }],
    order: [[{ model: ConversationTurn, as: 'turns' }, 'turnIndex', 'ASC']]
  })
}
