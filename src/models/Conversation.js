import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'

// Conversation model grouping related turns
export const Conversation = sequelize.define(
  'Conversation',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    apiKeyId: {
      type: DataTypes.UUID,
      allowNull: true
    },
    channel: {
      type: DataTypes.ENUM('dashboard', 'widget'),
      allowNull: false,
      defaultValue: 'dashboard'
    },
    sessionId: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    title: {
      type: DataTypes.STRING(200),
      allowNull: true
    },
    turnCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    }
  },
  {
    timestamps: true,
    tableName: 'conversations',
    indexes: [
      { fields: ['tenantId', 'createdAt'] },
      { fields: ['tenantId', 'userId'] },
      { fields: ['tenantId', 'apiKeyId'] }
    ]
  }
)
