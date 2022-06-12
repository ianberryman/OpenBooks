import {Bill, CreateBillResponse} from './Bill'

async function createBill(_, { createBillInput }, { dataSources }): Promise<CreateBillResponse> {
    const bill = await dataSources.billApi.createBill(await Bill.build(createBillInput))
    return {
        success: true,
        bill,
    }
}

const mutations = {
    createBill,
}

export default mutations