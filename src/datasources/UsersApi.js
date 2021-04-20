const { DataSource } = require('apollo-datasource');
const db = require('./db');


class UsersApi extends DataSource {
    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getUsers() {
        const client = await db.connect();
        const result = await client.query("SELECT id, first_name, last_name, email, user_role FROM users");
        client.release();
        return result.rows;
    }
}

module.exports = UsersApi;