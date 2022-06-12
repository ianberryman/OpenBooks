import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {ContactPerson} from '../types/ContactPerson/ContactPerson'

export default class ContactPersonApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createContactPerson(contactPerson: ContactPerson): Promise<ContactPerson> {
        return contactPerson.save()
    }

    async getContactPersonById(id: string): Promise<ContactPerson> {
        return ContactPerson.findByPk(idToBuffer(id))
    }
}