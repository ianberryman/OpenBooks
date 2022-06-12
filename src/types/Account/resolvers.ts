import {IResolvers} from '../IResolvers'
import {Account} from './Account'
import {TransactionType} from '../TransactionType'
import {AccountType} from '../AccountType'


async function accounts(parent, args, { dataSources }, info): Promise<Account> {
    return await dataSources.accountApi.getAccounts()
}

async function account(parent, { id }, { dataSources }, info): Promise<Array<Account>> {
    return await dataSources.accountApi.getAccountById(id)
}

async function balance(parent: Account, args, { dataSources }, info): Promise<number> {
    const credits = await dataSources.transactionApi.getTransactionByAccountIdAndType(parent.id, TransactionType.CREDIT)
    const debits = await dataSources.transactionApi.getTransactionByAccountIdAndType(parent.id, TransactionType.DEBIT)

    let balance = 0
    for(const credit of credits) {
        if ([AccountType.ASSET, AccountType.EXPENSE].includes(parent.accountType)) {
            balance -= credit.amount
        } else {
            balance += credit.amount
        }
    }
    for (const debit of debits) {
        if ([AccountType.ASSET, AccountType.EXPENSE].includes(parent.accountType)) {
            balance += debit.amount
        } else {
            balance -= debit.amount
        }
    }

    return balance
}

const resolvers: IResolvers = {
    api: {
        accounts,
        account
    },
    type: {
        Account: {
            balance,
        }
    }
}

export default resolvers