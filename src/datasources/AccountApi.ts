import {DataSource} from 'apollo-datasource'
import {Account} from '../types/Account/Account'
import {idToBuffer} from './db'

export default class AccountApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getAccounts(): Promise<Array<Account>> {
        return Account.findAll()
    }

    async getAccountById(id: string): Promise<Account> {
        return Account.findByPk(idToBuffer(id))
    }

    async createAccount(account: Account): Promise<Account> {
        return account.save()
    }
}