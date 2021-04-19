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
        const result = await db`SELECT id, first_name, last_name, email, user_role FROM user`;
        return result;
    }
}

module.exports = UsersApi;