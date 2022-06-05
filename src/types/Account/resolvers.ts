import {IResolvers} from '../IResolvers'


async function accounts(parent, args, { dataSources }, info) {
    return await dataSources.accountsApi.getAccounts()
}

async function account(parent, { id }, { dataSources }, info) {
    return await dataSources.accountsApi.getAccountById(id)
}

const resolvers: IResolvers = {
    api: {
        accounts,
        account
    },
    type: {
        Account: {}
    }
}

export default resolvers