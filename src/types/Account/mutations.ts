import {Account} from './Account'

async function createAccount(_, { createAccountInput }, { dataSources }): Promise<any> {
    return {
        success: true,
        account: dataSources.accountApi.createAccount(Account.build(createAccountInput))
    }
}

const mutations = {
    createAccount,
}

export default mutations