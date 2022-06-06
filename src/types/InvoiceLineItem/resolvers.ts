import {IResolvers} from '../IResolvers'
import {InvoiceLineItem} from './InvoiceLineItem'

async function product(parent: InvoiceLineItem, args, { dataSources }, info): Promise<number> {
    if (!parent.productId) return null
    return await dataSources.productApi.getProductById(parent.productId)
}

const resolvers: IResolvers = {
    api: {},
    type: {
        InvoiceLineItem: {
            product,
        }
    }
}
export default resolvers