import {AccountType} from "../AccountType";


export type Account = {
  id: string,
  account_name: string,
  account_type: AccountType,
  balance: number,
  is_system_account: boolean,
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