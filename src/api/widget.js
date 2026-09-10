import { Router } from 'express'

import { Tenant } from '../models/Tenant.js'
import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'
import {
  resolveWidgetConfig,
  normaliseWidgetConfig,
  WIDGET_DEFAULTS
} from '../services/widgetService.js'
import { WIDGET_SOURCE_MODES } from '../config.js'

const router = Router({ mergeParams: true })

router.use(authenticate, requireTenant)

const load = async (tenantId) =>
  await Tenant.findByPk(tenantId, { attributes: ['id', 'name', 'widgetConfig'] })

const missing = (res) =>
  res.status(404).json({ success: false, error: 'Workspace not found' })

router.get('/', async (req, res) => {
  try {
    const tenant = await load(req.user.tenantId)

    if (!tenant) return missing(res)

    return res.status(200).json({
      success: true,
      widget: resolveWidgetConfig(tenant.widgetConfig),
      defaults: WIDGET_DEFAULTS,
      sourceModes: WIDGET_SOURCE_MODES
    })
  } catch (error) {
    console.error('[WIDGET API] read failed:', error)

    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

router.put('/', async (req, res) => {
  try {
    const result = normaliseWidgetConfig(req.body)

    if (result.error) {
      return res.status(400).json({ success: false, error: result.error })
    }

    const tenant = await load(req.user.tenantId)

    if (!tenant) return missing(res)

    const stored = tenant.widgetConfig && typeof tenant.widgetConfig === 'object'
      ? tenant.widgetConfig
      : {}

    const merged = { ...stored, ...result.config }

    await tenant.update({ widgetConfig: merged })

    console.log(
      `[WIDGET API] ${req.user.tenantId}: updated ${Object.keys(result.config).join(', ')}`
    )

    return res.status(200).json({
      success: true,
      widget: resolveWidgetConfig(merged)
    })
  } catch (error) {
    console.error('[WIDGET API] update failed:', error)

    return res.status(500).json({ success: false, error: 'Internal server error' })
  }
})

export default router

