import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {CreateUserInput, User} from '../types/User/User'


export default class UsersApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createUser(userInput: CreateUserInput): Promise<User> {
        return User.create(userInput)
    }

    async getUsers(): Promise<Array<User>> {
        return User.findAll()
    }

    async getUserById(id: string): Promise<User> {
        return User.findByPk(idToBuffer(id))
    }
}