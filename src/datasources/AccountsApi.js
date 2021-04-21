const { DataSource } = require('apollo-datasource');
const db = require('./db');
const NotFoundError = require('../errors/NotFoundError');

class AccountsApi extends DataSource {
    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getAccounts() {
        const client = await db.connect();
        const result = await client.query("SELECT id, account_name, account_type, balance, is_system_account FROM account");
        client.release();

        return result.rows.map(account => ({
            id: account.id,
            name: account.account_name,
            accountType: account.account_type,
            balance: account.balance,
            isSystemAccount: account.is_system_account
        }));
    }

    async getAccountById(id) {
        const client = await db.connect();
        const result = await client.query("SELECT id, account_name, account_type, balance, is_system_account FROM account WHERE id = $1", [id]);
        client.release();

        const account = result.rows[0];
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

module.exports = AccountsApi;