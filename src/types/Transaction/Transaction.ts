import {TransactionType} from "../TransactionType";


export type Transaction = {
  id?: string,
  journalEntryId: string,
  accountId: string,
  type: TransactionType,
  description?: string,
  amount: number,
}

export type CreateTransactionInput = {
  accountId: string,
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
    accountId: String!
    description: String
    amount: Float!
  }
`