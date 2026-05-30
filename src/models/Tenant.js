import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import crypto from 'crypto'

export const Tenant = sequelize.define(
  'Tenant',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Tenant name is required' },
        len: {
          args: [2, 100],
          msg: 'Tenant name must be between 2 and 100 characters'
        }
      }
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        is: {
          args: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
          msg: 'Slug must contain only lowercase letters, numbers, and hyphens'
        },
        len: {
          args: [2, 60],
          msg: 'Slug must be between 2 and 60 characters'
        }
      },
      set(value) {
        this.setDataValue('slug', value?.toLowerCase().trim())
      }
    },
    ownerId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    apiKey: {
      type: DataTypes.STRING,
      unique: true,
      defaultValue: () => crypto.randomUUID()
    }
  },
  {
    timestamps: true,
    tableName: 'tenants',
    indexes: [
      { unique: true, fields: ['slug'] },
      { fields: ['ownerId'] }
    ]
  }
)
