import {IResolvers} from '../IResolvers'
import {Product} from './Product'

async function products(parent, args, { dataSources }, info): Promise<Array<Product>> {
    return dataSources.productApi.getProducts()
}

async function unitPrice(parent: Product, args, { dataSources }, info): Promise<number> {
    return parent.unitPrice + Number.EPSILON
}

const resolvers: IResolvers = {
    api: {
        products,
    },
    type: {
        Product: {
            unitPrice,
        }
    }
}
export default resolvers