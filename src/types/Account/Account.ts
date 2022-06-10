import {AccountType} from '../AccountType'


export type Account = {
  id: string,
  name: string,
  accountType: AccountType,
  isSystemAccount: boolean,
}

export const typeDefs = `
  type Account {
    id: String!
    name: String!
    accountType: AccountType!
    balance: String
    isSystemAccount: Boolean
  }
`