import {IResolvers} from '../IResolvers'
import {Bill} from './Bill'
import {Vendor} from '../Vendor/Vendor'

async function bill(parent, { id }, { dataSources }, info): Promise<Bill> {
    return dataSources.billApi.getBillById(id)
}

async function vendor(parent: Bill, args, { dataSources }, info): Promise<Vendor> {
    return parent.getVendor()
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