import { DataSource }  from 'apollo-datasource';
import { query } from './db';
import NotFoundError from '../errors/NotFoundError';

export default class AccountsApi extends DataSource {
    context: any

    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getAccounts() {
        const results = await query("SELECT id, account_name, account_type, balance, is_system_account FROM account");

        return results.map(account => ({
            id: account.id,
            name: account.account_name,
            accountType: account.account_type,
            balance: account.balance,
            isSystemAccount: account.is_system_account
        }));
    }

    async getAccountById(id: string) {
        const results = await query("SELECT id, account_name, account_type, balance, is_system_account FROM account WHERE id = $1", [id]);

        const account = results[0];
        if (!account) throw new NotFoundError("Account with ID " + id + " not found");
        
        return {
            id: account.id,
            name: account.account_name,
            accountType: account.account_type,
            balance: account.balance,
            isSystemAccount: account.is_system_account
          };
    }
}