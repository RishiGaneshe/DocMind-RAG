import { User } from './User.js'
import { Tenant } from './Tenant.js'
import { Document } from './Document.js'


User.hasOne(Tenant, {
  foreignKey: 'ownerId',
  as: 'ownedTenant'
})

Tenant.belongsTo(User, {
  foreignKey: 'ownerId',
  as: 'owner'
})

User.belongsTo(Tenant, {
  foreignKey: 'tenantId',
  as: 'tenant',
  constraints: false
})

Tenant.hasMany(User, {
  foreignKey: 'tenantId',
  as: 'members',
  constraints: false
})

Tenant.hasMany(Document, {
  foreignKey: 'tenantId'
})

Document.belongsTo(Tenant, {
  foreignKey: 'tenantId'
})


export { User, Tenant, Document }
