import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import { embeddingConfig } from '../config.js'
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

    // Recorded so the UI can show a page count without reopening the PDF, and
    // so a suspiciously low count on a large file flags a parse problem.
    numPages: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    // Recorded per document so a model switch is visible in the data rather
    // than inferred. Rows written before this change may name an older model.
    embeddingModel: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: embeddingConfig.model
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