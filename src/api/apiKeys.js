import { Router } from 'express'

import {
  createApiKey,
  listApiKeys,
  updateApiKey,
  revokeApiKey,
  rotateApiKey,
  apiKeyUsage
} from '../services/apiKeyService.js'
import { authenticate } from '../middleware/authenticate.js'
import { requireTenant } from '../middleware/requireTenant.js'
import { publicApiConfig, API_KEY_SCOPES } from '../config.js'

/**
 * Key management for the workspace owner. Mounted under
 * `/api/tenants/:tenantId/api-keys` behind the dashboard's JWT.
 *
 * `requireTenant` proves the `:tenantId` in the URL is the caller's own, and every
 * service call takes that tenant id as its first argument, so a key id belonging
 * to another workspace resolves to a 404 rather than to someone else's key.
 */

const router = Router({ mergeParams: true })

router.use(authenticate, requireTenant)

const failed = (res, error, context) => {
  if (error.status) {
    return res.status(error.status).json({
      success: false,
      error: error.message,
      ...(error.code ? { code: error.code } : {})
    })
  }

  console.error(`[API KEY API] ${context}:`, error)

  return res.status(500).json({ success: false, error: 'Internal server error' })
}

/**
 * Mints a key.
 *
 * The plaintext is in this response and in no other. It is not recoverable, not
 * by the owner and not by an operator with database access, because only its
 * SHA-256 is stored. The response says so explicitly so a UI has something to
 * render next to the copy button.
 */
router.post('/', async (req, res) => {
  try {
    const { apiKey, plaintext } = await createApiKey({
      tenantId: req.user.tenantId,
      createdBy: req.user.userId,
      name: req.body?.name,
      type: req.body?.type,
      scopes: req.body?.scopes,
      allowedOrigins: req.body?.allowedOrigins,
      rateLimitPerMinute: req.body?.rateLimitPerMinute,
      dailyQuota: req.body?.dailyQuota
    })

    console.log(
      `[API KEY API] ${req.user.tenantId}: created ${apiKey.type} key ` +
        `${apiKey.keyPrefix} (${apiKey.scopes.join(', ')})`
    )

    return res.status(201).json({
      success: true,
      key: plaintext,
      warning:
        'This is the only time the key is shown. Store it now — it cannot be ' +
        'retrieved later, only rotated.',
      apiKey: apiKey.toSafeJSON()
    })
  } catch (error) {
    return failed(res, error, 'create')
  }
})

router.get('/', async (req, res) => {
  try {
    const rows = await listApiKeys(req.user.tenantId)

    return res.status(200).json({
      success: true,
      apiKeys: rows.map((row) => row.toSafeJSON()),
      scopes: API_KEY_SCOPES,
      defaults: {
        ratePerMinute: publicApiConfig.defaultRatePerMinute,
        visitorRatePerMinute: publicApiConfig.visitorRatePerMinute,
        dailyQuota: publicApiConfig.defaultDailyQuota,
        maxKeysPerTenant: publicApiConfig.maxKeysPerTenant,
        originsRequired: publicApiConfig.requireOrigins
      }
    })
  } catch (error) {
    return failed(res, error, 'list')
  }
})

/**
 * Today's spend for one key. Separate from the list endpoint because it reads
 * Redis per key, and a workspace with 25 keys should not pay 25 round trips to
 * render a table.
 */
router.get('/:keyId/usage', async (req, res) => {
  try {
    const usage = await apiKeyUsage(req.user.tenantId, req.params.keyId)

    return res.status(200).json({ success: true, usage })
  } catch (error) {
    return failed(res, error, 'usage')
  }
})

router.patch('/:keyId', async (req, res) => {
  try {
    const row = await updateApiKey(req.user.tenantId, req.params.keyId, req.body ?? {})

    console.log(
      `[API KEY API] ${req.user.tenantId}: updated ${row.keyPrefix} ` +
        `(${Object.keys(req.body ?? {}).join(', ')})`
    )

    return res.status(200).json({ success: true, apiKey: row.toSafeJSON() })
  } catch (error) {
    return failed(res, error, 'update')
  }
})

/**
 * Issues a replacement and puts the old key on a grace timer, so a widget can be
 * redeployed without a window in which the site's chat is broken.
 *
 * `graceHours: 0` closes the old key immediately, which is the right call for a
 * suspected leak and the wrong one for routine hygiene.
 */
router.post('/:keyId/rotate', async (req, res) => {
  try {
    const { apiKey, plaintext, previous } = await rotateApiKey(
      req.user.tenantId,
      req.params.keyId,
      { graceHours: req.body?.graceHours }
    )

    console.log(
      `[API KEY API] ${req.user.tenantId}: rotated ${previous.keyPrefix} ` +
        `→ ${apiKey.keyPrefix}, old key ` +
        `${previous.revokedAt ? 'revoked now' : `valid until ${previous.expiresAt.toISOString()}`}`
    )

    return res.status(201).json({
      success: true,
      key: plaintext,
      warning:
        'This is the only time the new key is shown. Deploy it before the old ' +
        'key expires.',
      apiKey: apiKey.toSafeJSON(),
      previous: previous.toSafeJSON()
    })
  } catch (error) {
    return failed(res, error, 'rotate')
  }
})

/**
 * Revokes. Soft, so the row survives as a record of what was issued and when it
 * was withdrawn; the cache entry is dropped so it stops working on the next
 * request rather than at the end of the TTL.
 */
router.delete('/:keyId', async (req, res) => {
  try {
    const row = await revokeApiKey(req.user.tenantId, req.params.keyId)

    console.log(`[API KEY API] ${req.user.tenantId}: revoked ${row.keyPrefix}`)

    return res.status(200).json({ success: true, apiKey: row.toSafeJSON() })
  } catch (error) {
    return failed(res, error, 'revoke')
  }
})

export default router

