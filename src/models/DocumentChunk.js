import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import { chunkingConfig } from '../config.js'
import { Document } from './Document.js'
import { Tenant } from './Tenant.js'

// Document chunk model for hybrid search and text storage
export const DocumentChunk = sequelize.define(
  'DocumentChunk',
  {
    id: {
      type: DataTypes.STRING(128),
      primaryKey: true
    },

    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: Tenant,
        key: 'id'
      }
    },

    documentId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: Document,
        key: 'id'
      }
    },

    chunkIndex: {
      type: DataTypes.INTEGER,
      allowNull: false
    },

    text: {
      type: DataTypes.TEXT,
      allowNull: false
    },

    charCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },

    pageStart: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    pageEnd: {
      type: DataTypes.INTEGER,
      allowNull: true
    },

    heading: {
      type: DataTypes.STRING(512),
      allowNull: true
    },

    breadcrumb: {
      type: DataTypes.STRING(768),
      allowNull: true
    },

    chunkingVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: chunkingConfig.version
    }
  },
  {
    timestamps: true,
    tableName: 'document_chunks',

    indexes: [
      { fields: ['tenantId'] },
      { fields: ['documentId'] },
      { unique: true, fields: ['documentId', 'chunkIndex'] }
    ]
  }
)
