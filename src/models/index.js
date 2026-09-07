import { User } from './User.js'
import { Tenant } from './Tenant.js'
import { Document } from './Document.js'
import { DocumentChunk } from './DocumentChunk.js'
import { ApiKey } from './ApiKey.js'


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

// Deleting a document takes its chunks with it, so the lexical index can never
// outlive the rows it points at.
Document.hasMany(DocumentChunk, {
  foreignKey: 'documentId',
  as: 'chunks',
  onDelete: 'CASCADE'
})

DocumentChunk.belongsTo(Document, {
  foreignKey: 'documentId'
})


// Deleting a workspace takes its keys with it, so a revoked-by-deletion key can
// never resolve to a tenant row that is no longer there.
Tenant.hasMany(ApiKey, {
  foreignKey: 'tenantId',
  as: 'apiKeys',
  onDelete: 'CASCADE'
})

ApiKey.belongsTo(Tenant, {
  foreignKey: 'tenantId'
})

// The creator is recorded for audit only, so losing the user must not lose the
// key: the FK is ON DELETE SET NULL in the migration.
ApiKey.belongsTo(User, {
  foreignKey: 'createdBy',
  as: 'creator',
  constraints: false
})


export { User, Tenant, Document, DocumentChunk, ApiKey }
