import { User } from './User.js'
import { Tenant } from './Tenant.js'
import { Document } from './Document.js'
import { DocumentChunk } from './DocumentChunk.js'


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


export { User, Tenant, Document, DocumentChunk }
