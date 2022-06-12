import {IResolvers} from '../IResolvers'
import {Company} from './Company'

async function company(parent, { id }, { dataSources }, info) {
    return await dataSources.companyApi.getCompanyById(id)
}

async function companies(parent, args, { dataSources }, info) {
    return await dataSources.companyApi.getCompanies()
}

async function address(parent: Company, args, { dataSources }, info) {
    return parent.getAddress()
}

const resolvers: IResolvers = {
    api: {
        company,
        companies,
    },
    type: {
        Company: {
            address,
        }
    }
}

export default resolvers