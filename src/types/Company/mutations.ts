import {CreateCompanyResponse} from './Company'

async function createCompany(_, { createCompanyInput }, { dataSources }): Promise<CreateCompanyResponse> {
    const company = await dataSources.companyApi.createCompany(createCompanyInput)
    return {
        success: true,
        company,
    }
}

const mutations = {
    createCompany,
}

export default mutations