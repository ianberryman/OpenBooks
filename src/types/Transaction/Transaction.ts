import {TransactionType} from '../TransactionType'
import {DataTypes, Model} from 'sequelize'
import sequelize, {foreignKeyIdModel, idModel} from '../../datasources/db'
import {JournalEntry} from '../JournalEntry/JournalEntry'
import {Account} from '../Account/Account'


export class Transaction extends Model {
    declare id?: string
    declare journalEntryId: string
    declare accountId: string
    declare type: TransactionType
    declare description?: string
    declare amount: number

    declare getAccount: () => Promise<Account>
    declare getJournalEntry: () => Promise<JournalEntry>
}

Transaction.init({
    id: idModel(),
    journalEntryId: {
        ...foreignKeyIdModel('journalEntryId'),
        allowNull: false,
    },
    accountId: {
        ...foreignKeyIdModel('accountId'),
        allowNull: false,
    },
    type: {
        type: DataTypes.ENUM(...Object.keys(TransactionType)),
        allowNull: false,
    },
    description: {
        type: DataTypes.STRING(150),
    },
    amount: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
    },
}, { sequelize })
Transaction.belongsTo(JournalEntry, { foreignKey: 'journalEntryId' })
JournalEntry.Debits = JournalEntry.hasMany(Transaction, {
    foreignKey: 'journalEntryId',
    scope: {
        type: TransactionType.DEBIT,
    },
    as: 'debits',
})
JournalEntry.Credits = JournalEntry.hasMany(Transaction, {
    foreignKey: 'journalEntryId',
    scope: {
        type: 'FAILURE',
    },
    as: 'credits',
})
Transaction.belongsTo(Account, { foreignKey: 'accountId' })
Account.hasMany(Transaction, { foreignKey: 'accountId' })

export type CreateTransactionInput = {
  journalEntryId?: string,
  accountId: string,
  type?: TransactionType,
  description?: string,
  amount: number,
}

export const typeDefs = `
  type Transaction {
    id: String!
    journalEntry: JournalEntry!
    account: Account!
    type: TransactionType!
    description: String
    amount: Float!
  }
  
  input CreateTransactionInput {
    journalEntryId: String
    accountId: String!
    type: TransactionType
    description: String
    amount: Float!
  }
`