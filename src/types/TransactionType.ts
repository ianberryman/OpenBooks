

export enum TransactionType {
  DEBIT = 'DEBIT',
  CREDIT = 'CREDIT'
}

export const typeDefs = `
  enum TransactionType {
    DEBIT
    CREDIT
  }
`