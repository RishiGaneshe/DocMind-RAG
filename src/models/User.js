import { DataTypes } from 'sequelize'
import { sequelize } from '../services/db.js'
import bcrypt from 'bcrypt'

const SALT_ROUNDS = 12

export const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isEmail: { msg: 'Must be a valid email address' }
      },
      set(value) {
        this.setDataValue('email', value.toLowerCase().trim())
      }
    },
    password: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        len: {
          args: [8, 128],
          msg: 'Password must be between 8 and 128 characters'
        }
      }
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: { msg: 'First name is required' },
        len: {
          args: [1, 50],
          msg: 'First name must be between 1 and 50 characters'
        }
      },
      set(value) {
        this.setDataValue('firstName', value?.trim())
      }
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Last name is required' },
        len: {
          args: [1, 50],
          msg: 'Last name must be between 1 and 50 characters'
        }
      },
      set(value) {
        this.setDataValue('lastName', value?.trim())
      }
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: null
    },
    role: {
      type: DataTypes.ENUM('owner', 'member'),
      allowNull: false,
      defaultValue: 'owner'
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true
    }
  },
  {
    timestamps: true,
    tableName: 'users',
    indexes: [
      { unique: true, fields: ['email'] },
      { fields: ['tenantId'] }
    ],
    hooks: {
      beforeCreate: async (user) => {
        if (user.password) {
          user.password = await bcrypt.hash(user.password, SALT_ROUNDS)
        }
      },
      beforeUpdate: async (user) => {
        if (user.changed('password')) {
          user.password = await bcrypt.hash(user.password, SALT_ROUNDS)
        }
      }
    }
  }
)

User.prototype.verifyPassword = async function (plainPassword) {
  return bcrypt.compare(plainPassword, this.password)
}

User.prototype.toSafeJSON = function () {
  const values = { ...this.get() }
  delete values.password
  return values
}
