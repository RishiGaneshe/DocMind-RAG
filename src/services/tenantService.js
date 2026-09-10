import { User, Tenant } from '../models/index.js'
import { generateTokens } from './authService.js'

export const createTenant = async ({ name, slug, ownerId }) => {
  const existingTenant = await Tenant.findOne({ where: { slug } })

  if (existingTenant) {
    const error = new Error('A workspace with this slug already exists')
    error.status = 409
    throw error
  }

  const user = await User.findByPk(ownerId)

  if (!user) {
    const error = new Error('User not found')
    error.status = 404
    throw error
  }

  if (user.tenantId) {
    const error = new Error('User already has a workspace')
    error.status = 409
    throw error
  }

  const tenant = await Tenant.create({
    name: name.trim(),
    slug,
    ownerId
  })

  await user.update({ tenantId: tenant.id })

  // Reload user to get updated tenantId
  await user.reload()

  // Generate new tokens with tenantId embedded
  const tokens = generateTokens(user)

  return { tenant: await getTenantById(tenant.id), ...tokens }
}

const SAFE_ATTRIBUTES = { exclude: ['apiKey'] }

export const getTenantById = async (id) =>
  await Tenant.findByPk(id, { attributes: SAFE_ATTRIBUTES })

export const getTenantByOwnerId = async (ownerId) =>
  await Tenant.findOne({ where: { ownerId }, attributes: SAFE_ATTRIBUTES })
