import {IResolvers} from '../IResolvers'
import {InvoiceLineItem} from './InvoiceLineItem'

async function pricePerUnit(parent: InvoiceLineItem, args, { dataSources }, info): Promise<number> {
    return (parent.pricePerUnit + Number.EPSILON) / 100
}

const resolvers: IResolvers = {
    api: {},
    type: {
        InvoiceLineItem: {
            pricePerUnit,
        }
    }
}
export default resolvers