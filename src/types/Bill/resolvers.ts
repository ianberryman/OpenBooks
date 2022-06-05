import {IResolvers} from '../IResolvers'
import {Bill} from './Bill'
import {Vendor} from '../Vendor/Vendor'

async function bill(parent, { id }, { dataSources }, info): Promise<Bill> {
    return await dataSources.billApi.getBillById(id)
}

async function vendor(parent: Bill, args, { dataSources }, info): Promise<Vendor> {
    if (!parent.vendorId) return null
    return await dataSources.vendorApi.getVendorById(parent.vendorId)
}

const resolvers: IResolvers = {
    api: {
        bill,
    },
    type: {
        Bill: {
            vendor,
        }
    }
}
export default resolvers