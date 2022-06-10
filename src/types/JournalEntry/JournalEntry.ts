import {CreateTransactionInput} from "../Transaction/Transaction";


export type JournalEntry = {
  id?: string,
  description?: string,
  effectiveDate: string,
  createdDate: string,
}

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
    createdDate: String!
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