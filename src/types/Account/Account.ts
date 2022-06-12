import {AccountType} from '../AccountType'
import {DataTypes, Model} from 'sequelize'
import sequelize, {idModel} from '../../datasources/db'


export class Account extends Model {
    declare id: string
    declare name: string
    declare accountType: AccountType
    declare isSystemAccount: boolean
}

Account.init({
    id: idModel(),
    name: {
        type: DataTypes.STRING(50),
        allowNull: false,
    },
    accountType: {
        type: DataTypes.ENUM(...Object.keys(AccountType)),
        allowNull: false,
    },
    isSystemAccount: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
    }
}, { sequelize } )

export const typeDefs = `
  type Account {
    id: String!
    name: String!
    accountType: AccountType!
    balance: String
    isSystemAccount: Boolean
  }
  
  input CreateAccountInput {
    name: String!
    accountType: AccountType!
  }
  
  type CreateAccountResponse {
    success: Boolean!
    account: Account
  }
`