import {IResolvers} from '../IResolvers'
import {Address} from '../Address/Address'
import {ContactPerson} from '../ContactPerson/ContactPerson'
import {ConsumerCustomer} from './ConsumerCustomer'

async function address(parent: ConsumerCustomer, args, { dataSources }, info): Promise<Address> {
    if (!parent.addressId) return null
    return await dataSources.addressApi.getAddressById(parent.addressId)
}

async function primaryContact(parent: ConsumerCustomer, args, { dataSources }, info): Promise<ContactPerson> {
    if (!parent.primaryContactId) return null
    return await dataSources.contactPersonApi.getContactPersonById(parent.primaryContactId)
}

const resolvers: IResolvers = {
    api: {},
    type: {
        ConsumerCustomer: {
            address,
            primaryContact,
        }
    }
}
export default resolvers