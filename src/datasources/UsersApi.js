const { DataSource } = require('apollo-datasource');
const db = require('./db');


const queries = {
    getUsers: "SELECT HEX(Id) as Id, FirstName, LastName, Email, UserRole FROM user"
}

class UsersApi extends DataSource {
    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async getUsers() {
        const [rows, fields] = await db.execute(queries.getUsers);
        return rows;
    }
}

module.exports = UsersApi;