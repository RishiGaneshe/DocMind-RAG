import { Router } from 'express'
import { createTenant, getTenantByOwnerId } from '../services/tenantService.js'
import { authenticate } from '../middleware/authenticate.js'

const router = Router()

// ── POST /api/tenants — Create tenant for authenticated user ──
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, slug } = req.body

    if (!name || !slug) {
      return res.status(400).json({
        success: false,
        error: 'Workspace name and slug are required'
      })
    }

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      return res.status(400).json({
        success: false,
        error: 'Slug must contain only lowercase letters, numbers, and hyphens'
      })
    }

    const result = await createTenant({
      name,
      slug,
      ownerId: req.user.userId
    })

    console.log(`[TENANT API] Workspace created successfully: ${slug}`)

    return res.status(201).json({
      success: true,
      message: 'Workspace created successfully',
      tenant: result.tenant,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken
    })
  } catch (error) {
    if (error.status === 409) {
      return res.status(409).json({ success: false, error: error.message })
    }
    if (error.status === 404) {
      return res.status(404).json({ success: false, error: error.message })
    }
    if (error.name === 'SequelizeValidationError') {
      return res.status(400).json({
        success: false,
        error: error.errors.map((e) => e.message).join(', ')
      })
    }
    console.error('Error creating tenant:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

// ── GET /api/tenants/me — Get current user's tenant ──
router.get('/me', authenticate, async (req, res) => {
  try {
    const tenant = await getTenantByOwnerId(req.user.userId)

    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: 'No workspace found. Please create one first.'
      })
    }

    console.log(`[TENANT API] Workspace fetched successfully for user ID: ${req.user.userId}`)

    return res.status(200).json({
      success: true,
      tenant
    })
  } catch (error) {
    console.error('Error fetching tenant:', error)
    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

export default router
