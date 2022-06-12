import {CreateCustomerResponse} from './Customer'

async function createCustomer(_, { createCustomerInput }, { dataSources }): Promise<CreateCustomerResponse> {
    const customer = dataSources.customerApi.createCustomer(createCustomerInput)
    return {
        success: true,
        customer,
    }
}

const mutations = {
    createCustomer,
}

export default mutations