import {CreateVendorResponse, Vendor} from './Vendor'

async function createVendor(_, { createVendorInput }, { dataSources }): Promise<CreateVendorResponse> {
    const vendor = await dataSources.vendorApi.createVendor(Vendor.build(createVendorInput))
    return {
        success: true,
        vendor,
    }
}

const mutations = {
    createVendor,
}

export default mutations