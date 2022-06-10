
export enum AccountType {
  INCOME = 'INCOME',
  EXPENSE = 'EXPENSE',
  ASSET = 'ASSET',
  LIABILITY = 'LIABILITY',
  EQUITY = 'EQUITY',
}

export const typeDefs = `
  enum AccountType {
    INCOME
    EXPENSE
    ASSET
    LIABILITY
    EQUITY
  }
`