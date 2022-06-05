import { DataSource }  from 'apollo-datasource'
import { query } from './db'
import NotFoundError from '../errors/NotFoundError'
import {Customer} from '../types/Customer/Customer'

export default class CustomerApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getCustomerById(id: string): Promise<Customer> {
        const results = await query('SELECT hex(id) as id, customer_type, name, first_name, last_name, hex(address_id) as address_id, website, email, phone, hex(primary_contact_id) as primary_contact_id FROM customer WHERE id = unhex(?)', [id])

        const customer = results[0]
        if (!customer) throw new NotFoundError('Customer with id: ' + id + ' not found')

        return {
            id: customer.id,
            customerType: customer.customer_type,
            firstName: customer.first_name,
            lastName: customer.last_name,
            addressId: customer.address_id,
            website: customer.website,
            email: customer.email,
            phone: customer.phone,
            primaryContactId: customer.primary_contact_id,
        }
    }
}