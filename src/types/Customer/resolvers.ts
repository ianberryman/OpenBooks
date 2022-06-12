import {IResolvers} from '../IResolvers'
import {Customer} from './Customer'
import {Address} from '../Address/Address'
import {ContactPerson} from '../ContactPerson/ContactPerson'

async function customer(parent, { id }, { dataSources }, info): Promise<Customer> {
    return dataSources.customerApi.getCustomerById(id)
}

async function customers(parent, args, { dataSources }, info): Promise<Array<Customer>> {
    return dataSources.customerApi.getCustomers()
}

async function address(parent: Customer, args, { dataSources }, info): Promise<Address> {
    return parent.getAddress()
}

async function primaryContact(parent: Customer, args, { dataSources }, info): Promise<ContactPerson> {
    return parent.getPrimaryContact()
}

const resolvers: IResolvers = {
    api: {
        customer,
        customers,
    },
    type: {
        Customer: {
            address,
            primaryContact,
        }
    }
}
export default resolvers