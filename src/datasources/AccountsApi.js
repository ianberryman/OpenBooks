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
        const client = await db.connect();
        const result = await client.query("SELECT id, account_name, account_type, balance, is_system_account FROM account");
        return result.rows;
    }

    async getAccountById(id) {
        const client = await db.connect();
        const result = await client.query("SELECT id, account_name, account_type, balance, is_system_account FROM account WHERE id = $1", [id]);
        return result.rows[0];
    }
}

module.exports = AccountsApi;