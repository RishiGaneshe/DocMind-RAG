import {
  recordTurn,
  getConversations,
  getConversationWithTurns
} from '../services/conversationService.js'
import { Conversation, ConversationTurn, Tenant } from '../models/index.js'
import { NO_ANSWER_MESSAGE } from '../config.js'

jest.mock('../models/index.js', () => ({
  Conversation: {
    findOne: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    findAndCountAll: jest.fn(),
    increment: jest.fn()
  },
  ConversationTurn: {
    create: jest.fn()
  },
  Tenant: {}
}))

describe('conversationService', () => {
  afterEach(() => {
    jest.clearAllMocks()
  })

  describe('recordTurn', () => {
    const defaultArgs = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      channel: 'dashboard',
      query: 'What is the refund policy?',
      result: {
        answer: 'You can refund within 30 days.',
        chunksUsed: 3,
        sources: [],
        retrieval: { stage: 'final', stats: { elapsedMs: 150 } }
      },
      responseTimeMs: 800,
      streamMode: false
    }

    it('creates a new conversation if no sessionId is provided', async () => {
      Conversation.create.mockResolvedValue({ id: 'conv-1', turnCount: 0 })
      ConversationTurn.create.mockResolvedValue({ id: 'turn-1' })
      Conversation.update.mockResolvedValue([1])

      const result = await recordTurn(defaultArgs)

      expect(Conversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          channel: 'dashboard',
          sessionId: null,
          title: 'What is the refund policy?',
          turnCount: 0
        })
      )
      expect(ConversationTurn.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-1',
          tenantId: 'tenant-1',
          turnIndex: 0,
          query: 'What is the refund policy?',
          answer: 'You can refund within 30 days.'
        })
      )
      expect(Conversation.update).toHaveBeenCalledWith(
        { turnCount: 1 },
        { where: { id: 'conv-1' } }
      )
      expect(result).toEqual({ conversationId: 'conv-1', turnId: 'turn-1' })
    })

    it('resumes an existing widget conversation if sessionId matches', async () => {
      Conversation.findOne.mockResolvedValue({ id: 'conv-2', turnCount: 2 })
      ConversationTurn.create.mockResolvedValue({ id: 'turn-3' })

      const args = {
        ...defaultArgs,
        channel: 'widget',
        sessionId: 'session-xyz',
        apiKeyId: 'key-1',
        userId: undefined
      }

      await recordTurn(args)

      expect(Conversation.findOne).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', sessionId: 'session-xyz', channel: 'widget' },
        attributes: ['id', 'turnCount']
      })
      expect(Conversation.create).not.toHaveBeenCalled()
      expect(ConversationTurn.create).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-2',
          turnIndex: 2
        })
      )
      expect(Conversation.update).toHaveBeenCalledWith(
        { turnCount: 3 },
        { where: { id: 'conv-2' } }
      )
    })

    it('sets noAnswer=true when model refuses', async () => {
      Conversation.create.mockResolvedValue({ id: 'conv-1', turnCount: 0 })
      ConversationTurn.create.mockResolvedValue({ id: 'turn-1' })

      await recordTurn({
        ...defaultArgs,
        result: {
          ...defaultArgs.result,
          answer: NO_ANSWER_MESSAGE
        }
      })

      expect(ConversationTurn.create).toHaveBeenCalledWith(
        expect.objectContaining({
          noAnswer: true
        })
      )
    })

    it('catches and swallows errors (fire-and-forget)', async () => {
      Conversation.create.mockRejectedValue(new Error('DB failure'))

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
      
      const result = await recordTurn(defaultArgs)
      
      expect(result).toBeNull()
      expect(consoleSpy).toHaveBeenCalled()
      
      consoleSpy.mockRestore()
    })
  })

  describe('getConversations', () => {
    it('finds and counts conversations', async () => {
      Conversation.findAndCountAll.mockResolvedValue({ count: 1, rows: [{ id: 'conv-1' }] })

      const result = await getConversations('tenant-1', { limit: 10 })

      expect(Conversation.findAndCountAll).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-1' },
          limit: 10
        })
      )
      expect(result.count).toBe(1)
    })
  })
})
