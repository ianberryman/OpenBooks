import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {BusinessCustomerFields, ConsumerCustomerFields, CreateCustomerInput, Customer} from '../types/Customer/Customer'
import {CustomerType} from '../types/CustomerType'

export default class CustomerApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createCustomer(customerInput: CreateCustomerInput): Promise<Customer> {
        if (customerInput.customerType === CustomerType.Business) {
            return Customer.create(customerInput, { fields: BusinessCustomerFields })
        } else if (customerInput.customerType === CustomerType.Consumer) {
            return Customer.create(customerInput, { fields: ConsumerCustomerFields })
        } else {
            throw new Error(`Unknown customerType: ${customerInput.customerType}`)
        }
    }

    async getCustomerById(id: string): Promise<Customer> {
        return Customer.findByPk(idToBuffer(id))
    }

    async getCustomers(): Promise<Array<Customer>> {
        return Customer.findAll()
    }
}