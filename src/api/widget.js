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

/**
 * Widget appearance and the source-exposure mode, for the workspace owner.
 *
 * The stored JSONB holds only the keys the owner has actually changed; defaults
 * are applied on read. That way raising a default — or adding a setting — takes
 * effect for every workspace that never touched it, instead of leaving a fleet of
 * rows frozen at whatever the defaults were on the day they were created.
 */

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

/**
 * Partial update. Only the supplied keys are written, merged over what is already
 * stored, so a form that posts one field does not silently reset the rest.
 *
 * Last write wins if the owner has the settings page open twice. A read-modify-
 * write is the wrong shape for that in general, but these are single-owner
 * presentation settings, and the alternative — a version column and a conflict
 * dialog — costs more than the problem.
 */
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

