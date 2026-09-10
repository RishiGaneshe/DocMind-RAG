import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'

// Conversation turn model for recording Q&A exchanges
export const ConversationTurn = sequelize.define(
  'ConversationTurn',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    conversationId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    turnIndex: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },

    // ── Question ──
    query: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    searchQuery: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    rewritten: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },

    // ── Answer ──
    answer: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    noAnswer: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    cached: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },

    // ── Retrieval metadata ──
    chunksUsed: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    sources: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: []
    },
    citedSources: {
      type: DataTypes.ARRAY(DataTypes.INTEGER),
      allowNull: false,
      defaultValue: []
    },
    retrievalStage: {
      type: DataTypes.STRING(32),
      allowNull: true
    },
    retrievalStats: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {}
    },

    // ── Performance ──
    responseTimeMs: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    streamMode: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },

    // ── Models used ──
    llmModel: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    embeddingModel: {
      type: DataTypes.STRING(100),
      allowNull: true
    },

    // ── User feedback (Phase 2) ──
    feedbackRating: {
      type: DataTypes.SMALLINT,
      allowNull: true
    },
    feedbackNote: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    feedbackAt: {
      type: DataTypes.DATE,
      allowNull: true
    },

    // ── Knowledge promotion (Phase 2) ──
    promotedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    promotedChunkId: {
      type: DataTypes.STRING(128),
      allowNull: true
    }
  },
  {
    timestamps: true,
    tableName: 'conversation_turns',
    indexes: [
      { fields: ['conversationId', 'turnIndex'] },
      { fields: ['tenantId', 'createdAt'] }
    ]
  }
)
