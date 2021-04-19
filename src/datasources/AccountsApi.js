const { DataSource } = require('apollo-datasource');
const db = require('./db');


class AccountsApi extends DataSource {
    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getAccounts() {
        const result = await db`SELECT id, account_name, account_type, balance, is_system_account FROM account`;
        return result;
    }

    async getAccountById(id) {
        const result = await db`SELECT id, account_name, account_type, balance, is_system_account FROM account WHERE id = ${id}`;
        return result[0];
    }
}

module.exports = AccountsApi;