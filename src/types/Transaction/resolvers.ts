import {IResolvers} from "../IResolvers";
import {Transaction} from "./Transaction";
import {Account} from "../Account/Account";

async function account(parent: Transaction, args, { dataSources }, info): Promise<Account> {
  if (!parent.accountId) return null
  return dataSources.accountApi.getAccountById(parent.accountId)
}

const resolvers: IResolvers = {
  api: {},
  type: {
    Transaction: {
      account,
    }
  }
}
export default resolvers