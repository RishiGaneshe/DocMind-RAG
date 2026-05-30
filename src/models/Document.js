import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import { Tenant } from './Tenant.js'

export const Document = sequelize.define(
  'Document',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      unique: true
    },

    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: Tenant,
        key: 'id'
      }
    },

    filename: {
      type: DataTypes.STRING,
      allowNull: false
    },

    mimeType: {
      type: DataTypes.STRING,
      allowNull: false
    },

    fileSize: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    contentHash: {
      type: DataTypes.STRING(64),
      allowNull: false
    },

    totalChunks: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },

    embeddingModel: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'nomic-embed-text'
    },

    status: {
      type: DataTypes.ENUM(
        'PENDING',
        'PROCESSING',
        'COMPLETED',
        'FAILED'
      ),
      allowNull: false,
      defaultValue: 'PENDING'
    },

    processingStartedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },

    processingCompletedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },

    failureReason: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  },
  {
    timestamps: true,
    tableName: 'documents',

    indexes: [
      {
        fields: ['tenantId']
      },

      {
        fields: ['status']
      },

      {
        fields: ['tenantId', 'contentHash']
      },

      {
        fields: ['tenantId', 'createdAt']
      }
    ]
  }
)