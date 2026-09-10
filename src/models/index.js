import { User } from './User.js'
import { Tenant } from './Tenant.js'
import { Document } from './Document.js'
import { DocumentChunk } from './DocumentChunk.js'
import { ApiKey } from './ApiKey.js'
import { Conversation } from './Conversation.js'
import { ConversationTurn } from './ConversationTurn.js'


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

// Cascade delete chunks when document is deleted
Document.hasMany(DocumentChunk, {
  foreignKey: 'documentId',
  as: 'chunks',
  onDelete: 'CASCADE'
})

DocumentChunk.belongsTo(Document, {
  foreignKey: 'documentId'
})

// Cascade delete API keys when tenant is deleted
Tenant.hasMany(ApiKey, {
  foreignKey: 'tenantId',
  as: 'apiKeys',
  onDelete: 'CASCADE'
})

ApiKey.belongsTo(Tenant, {
  foreignKey: 'tenantId'
})

ApiKey.belongsTo(User, {
  foreignKey: 'createdBy',
  as: 'creator',
  constraints: false
})

// Cascade delete conversations when tenant is deleted
Tenant.hasMany(Conversation, {
  foreignKey: 'tenantId',
  as: 'conversations',
  onDelete: 'CASCADE'
})

Conversation.belongsTo(Tenant, {
  foreignKey: 'tenantId'
})

// Optional: the dashboard user who started the conversation.
Conversation.belongsTo(User, {
  foreignKey: 'userId',
  as: 'user',
  constraints: false
})

// Optional: the API key used by a widget visitor.
Conversation.belongsTo(ApiKey, {
  foreignKey: 'apiKeyId',
  as: 'apiKey',
  constraints: false
})

// Deleting a conversation takes its turns with it.
Conversation.hasMany(ConversationTurn, {
  foreignKey: 'conversationId',
  as: 'turns',
  onDelete: 'CASCADE'
})

ConversationTurn.belongsTo(Conversation, {
  foreignKey: 'conversationId'
})


export { User, Tenant, Document, DocumentChunk, ApiKey, Conversation, ConversationTurn }
