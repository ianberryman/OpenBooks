
export enum AccountType {
  Income = 'Income',
  Expense = 'Expense',
  Asset = 'Asset',
  Liability = 'Liability',
  Equity = 'Equity',
}

export const typeDefs = `
  enum AccountType {
    Income
    Expense
    Asset
    Liability
    Equity
  }
`