import { DataSource } from 'apollo-datasource'
import { query } from './db'
import {User} from '../types/User/User'


export default class UsersApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getUsers() {
        return await query('SELECT hex(id) as id, first_name, last_name, email, user_role FROM users')
    }

    async getUserById(id: string): Promise<User> {
        const results = await query('SELECT hex(id) as id, first_name, last_name, email, user_role FROM users WHERE id = unhex(?)', [id])
        return results[0]
    }
}