import {CreateTransactionInput, Transaction} from '../Transaction/Transaction'
import {DataTypes, HasMany, Model} from 'sequelize'
import sequelize, {idModel} from '../../datasources/db'


export class JournalEntry extends Model {
    static Debits: HasMany<JournalEntry, Transaction>
    static Credits: HasMany<JournalEntry, Transaction>

    declare id?: string
    declare description?: string
    declare effectiveDate: string

    declare getDebits: () => Promise<Array<Transaction>>
    declare getCredits: () => Promise<Array<Transaction>>
}

JournalEntry.init({
    id: idModel(),
    description: {
        type: DataTypes.STRING(150),
    },
    effectiveDate: {
        type: DataTypes.DATE,
    }
}, { sequelize })

export type CreateJournalEntryInput = {
  description?: string,
  effectiveDate: string,
  debits: [CreateTransactionInput],
  credits: [CreateTransactionInput],
}

export type CreateJournalEntryResponse = {
  success: boolean,
  journalEntry: JournalEntry,
}

export const typeDefs = `
  type JournalEntry {
    id: String!
    description: String
    effectiveDate: String!
    debits: [Transaction!]
    credits: [Transaction!]
  }
  
  input CreateJournalEntryInput {
    description: String
    effectiveDate: String!
    debits: [CreateTransactionInput!]!
    credits: [CreateTransactionInput!]!
  }
  
  type CreateJournalEntryResponse {
    success: Boolean!
    journalEntry: JournalEntry
  }
`