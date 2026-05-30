export const requireTenant = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: 'Authentication required'
    })
  }

  if (!req.user.tenantId) {
    return res.status(403).json({
      success: false,
      error: 'Tenant setup required. Please create a workspace first.',
      code: 'TENANT_REQUIRED'
    })
  }

  // If tenantId is in URL params, validate it matches the authenticated user's tenant
  const paramTenantId = req.params.tenantId
  if (paramTenantId && paramTenantId !== req.user.tenantId) {
    return res.status(403).json({
      success: false,
      error: 'Access denied. You do not have permission to access this workspace.',
      code: 'TENANT_MISMATCH'
    })
  }

  next()
}
