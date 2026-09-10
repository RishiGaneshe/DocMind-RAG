import { Router } from 'express'
import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'
import {
  getConversations,
  getConversationWithTurns
} from '../services/conversationService.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireTenant)

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.get('/', async (req, res) => {
  try {
    const { tenantId } = req.params
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100)
    const offset = Math.max(Number(req.query.offset) || 0, 0)
    const userId = req.query.mine === 'true' ? req.user.userId : undefined

    const { count, rows } = await getConversations(tenantId, {
      userId,
      limit,
      offset
    })

    return res.status(200).json({
      success: true,
      conversations: rows,
      total: count,
      limit,
      offset
    })
  } catch (error) {
    console.error('[CONVERSATIONS] list error:', error)

    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve conversations'
    })
  }
})

router.get('/:conversationId', async (req, res) => {
  try {
    const { tenantId, conversationId } = req.params

    if (!UUID_PATTERN.test(conversationId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid conversation ID'
      })
    }

    const conversation = await getConversationWithTurns(tenantId, conversationId)

    if (!conversation) {
      return res.status(404).json({
        success: false,
        error: 'Conversation not found'
      })
    }

    return res.status(200).json({
      success: true,
      conversation
    })
  } catch (error) {
    console.error('[CONVERSATIONS] detail error:', error)

    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve conversation'
    })
  }
})

export default router
