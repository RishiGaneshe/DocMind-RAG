import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import { chunkingConfig } from '../config.js'
import { Document } from './Document.js'
import { Tenant } from './Tenant.js'

/**
 * Chunk text lives here rather than only in Pinecone metadata. Pulling text
 * back for a wide candidate set was measured at 1.6-2.8s for topK=40 against
 * 0.3-0.7s for ids alone, because ~100KB of document text was crossing the
 * wire on every query. Postgres hydrates the same rows by primary key in a
 * single round trip and doubles as the lexical half of hybrid retrieval.
 *
 * The primary key is the Pinecone record id (`<documentId>-chunk-<index>`), so
 * hydration after an ANN query is one `WHERE id IN (...)` with no join.
 */
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

    // Null for chunks backfilled from Pinecone metadata, which never recorded
    // page or heading information.
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

    // `filename › page 4 › Revenue`, shown to the model as the source label so
    // a citation points at a location and not just a number.
    breadcrumb: {
      type: DataTypes.STRING(768),
      allowNull: true
    },

    // Which parser/splitter produced this row. Version 1 is the original
    // 500-word fixed window; retrieval must keep serving those rows because
    // existing vectors are never re-embedded.
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
