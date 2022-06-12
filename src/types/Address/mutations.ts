import {Address, CreateAddressResponse} from './Address'

async function createAddress(_, { createAddressInput }, { dataSources }): Promise<CreateAddressResponse> {
    const address = dataSources.addressApi.createAddress(Address.build(createAddressInput))
    return {
        success: true,
        address,
    }
}

const mutations = {
    createAddress,
}

export default mutations