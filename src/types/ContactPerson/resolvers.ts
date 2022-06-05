import {IResolvers} from '../IResolvers'
import {Address} from '../Address/Address'
import {ContactPerson} from './ContactPerson'

async function address(parent: ContactPerson, args, { dataSources }, info): Promise<Address> {
    if (!parent.addressId) return null
    return await dataSources.addressApi.getAddressById(parent.addressId)
}

const resolvers: IResolvers = {
    api: {},
    type: {
        ContactPerson: {
            address,
        }
    }
}

export default resolvers