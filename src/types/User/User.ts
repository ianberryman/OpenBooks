import {UserRole} from '../UserRole'
import {DataTypes, Model} from 'sequelize'
import sequelize, {idModel} from '../../datasources/db'
import {Security} from '../../utils/Security'

export class User extends Model {
    declare id: string
    declare firstName: string
    declare lastName: string
    declare email: string
    declare phoneNumber: string
    declare role: UserRole
}

User.init({
    id: idModel(),
    firstName: {
        type: DataTypes.STRING(50),
        allowNull: false,
    },
    lastName: {
        type: DataTypes.STRING(50),
        allowNull: false,
    },
    email: {
        type: DataTypes.STRING(300),
        allowNull: false,
        unique: true,
        validate: {
            isEmail: true,
        },
    },
    phoneNumber: {
        type: DataTypes.STRING(15),
        // validate: {
        //     isPhone: () => {}
        // },
    },
    password: {
        type: 'BINARY(60)',
        set(rawPass: string) {
            if (rawPass.length < 8) {
                throw new Error('Password must be 8 or more characters long')
            }

            this.setDataValue('password', Security.hashPassword(rawPass))
        },
    },
    role: {
        type: DataTypes.ENUM(...Object.keys(UserRole)),
        allowNull: false,
    },
}, { sequelize })

export type CreateUserInput = {
    firstName: string,
    lastName: string,
    email: string,
    password: string,
    userRole: UserRole,
    phoneNumber?: string
}

export type CreateUserResponse = {
    success: boolean,
    user: User,
}

export const typeDefs = `
  type User {
    id: String!
    firstName: String!
    lastName: String!
    email: String!
    phoneNumber: String
    role: UserRole!
  }
  
  input CreateUserInput {
    firstName: String!
    lastName: String!
    email: String!
    password: String
    phoneNumber: String
    role: UserRole!
  }
  
  type CreateUserResponse {
    success: Boolean!
    user: User
  }
`