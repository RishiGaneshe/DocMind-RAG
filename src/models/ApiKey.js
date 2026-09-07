import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'

/**
 * An API key belonging to a workspace.
 *
 * The plaintext key exists exactly once, in the response to the request that
 * created it. What lives here is `keyHash` — sha256 of the full key — plus the
 * prefix and last four characters, which are enough to identify a key in a list
 * and useless for authenticating.
 *
 * `rateLimitPerMinute` and `dailyQuota` are nullable rather than defaulted in the
 * column, so a key that has never been tuned follows the deployment-wide default
 * in `config.js` and picks up changes to it, instead of being frozen at whatever
 * the default happened to be on the day it was minted.
 */
export const ApiKey = sequelize.define(
  'ApiKey',
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
    createdBy: {
      type: DataTypes.UUID,
      allowNull: true
    },
    name: {
      type: DataTypes.STRING(80),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Key name is required' },
        len: {
          args: [1, 80],
          msg: 'Key name must be between 1 and 80 characters'
        }
      },
      set(value) {
        this.setDataValue('name', value?.trim())
      }
    },
    type: {
      type: DataTypes.ENUM('public', 'secret'),
      allowNull: false,
      defaultValue: 'public'
    },
    keyPrefix: {
      type: DataTypes.STRING(32),
      allowNull: false
    },
    keyLast4: {
      type: DataTypes.STRING(4),
      allowNull: false
    },
    keyHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: true
    },
    scopes: {
      type: DataTypes.ARRAY(DataTypes.TEXT),
      allowNull: false,
      defaultValue: []
    },
    allowedOrigins: {
      type: DataTypes.ARRAY(DataTypes.TEXT),
      allowNull: false,
      defaultValue: []
    },
    rateLimitPerMinute: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    dailyQuota: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    lastUsedIp: {
      type: DataTypes.STRING(64),
      allowNull: true
    },
    totalRequests: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    // Set when a key is rotated: the old secret keeps working until this passes,
    // so a widget can be redeployed without a window of broken chat.
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true
    },
    rotatedFromId: {
      type: DataTypes.UUID,
      allowNull: true
    }
  },
  {
    timestamps: true,
    tableName: 'api_keys',
    indexes: [
      { unique: true, fields: ['keyHash'] },
      { fields: ['tenantId'] }
    ]
  }
)

/**
 * The dashboard shape. Deliberately not `toJSON`: an accidental
 * `res.json(apiKey)` should be a visible mistake, not a silent hash leak.
 */
ApiKey.prototype.toSafeJSON = function () {
  const values = this.get()

  return {
    id: values.id,
    name: values.name,
    type: values.type,
    maskedKey: `${values.keyPrefix}${'•'.repeat(8)}${values.keyLast4}`,
    keyPrefix: values.keyPrefix,
    scopes: values.scopes,
    allowedOrigins: values.allowedOrigins,
    unrestricted: values.allowedOrigins.length === 0,
    rateLimitPerMinute: values.rateLimitPerMinute,
    dailyQuota: values.dailyQuota,
    lastUsedAt: values.lastUsedAt,
    totalRequests: Number(values.totalRequests ?? 0),
    expiresAt: values.expiresAt,
    revokedAt: values.revokedAt,
    status: values.revokedAt
      ? 'revoked'
      : values.expiresAt && values.expiresAt <= new Date()
        ? 'expired'
        : 'active',
    createdAt: values.createdAt
  }
}
