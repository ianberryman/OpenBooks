import {IResolvers} from '../IResolvers'
import {Vendor} from './Vendor'
import {ContactPerson} from '../ContactPerson/ContactPerson'
import {Address} from '../Address/Address'

async function vendor(parent, { id }, { dataSources }, info): Promise<Vendor> {
    return await dataSources.vendorApi.getVendorById(id)
}

async function address(parent: Vendor, args, { dataSources }, info): Promise<Address> {
    if (!parent.addressId) return null
    return await dataSources.addressApi.getAddressById(parent.addressId)
}

async function primaryContact(parent: Vendor, args, { dataSources }, info): Promise<ContactPerson> {
    if (!parent.primaryContactId) return null
    return await dataSources.contactPersonApi.getContactPersonById(parent.primaryContactId)
}

const resolvers: IResolvers = {
    api: {
        vendor,
    },
    type: {
        Vendor: {
            address,
            primaryContact,
        }
    }
}
export default resolvers