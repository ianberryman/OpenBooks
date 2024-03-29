import {IResolvers} from '../IResolvers'


async function address(parent, { id }, { dataSources }, info) {
    return dataSources.addressApi.getAddressById(id)
}

const resolvers: IResolvers = {
    api: {
        address,
    },
    type: {
        Address: {}
    }
}
export default resolvers