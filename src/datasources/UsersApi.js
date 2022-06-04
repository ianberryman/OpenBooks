import { DataSource } from 'apollo-datasource';
import { query } from './db';


class UsersApi extends DataSource {
    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getUsers() {
        return await query("SELECT hex(id) as id, first_name, last_name, email, user_role FROM users");
    }
}

module.exports = UsersApi;