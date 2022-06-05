

// async function companies(parent, args, { dataSources }, info) {
//   return await dataSources.companiesApi.getCompanies()
// }

import {IResolvers} from "../IResolvers";
import {Company} from "./Company";

async function company(parent, { id }, { dataSources }, info) {
  return await dataSources.companyApi.getCompanyById(id)
}

async function address(parent: Company, args, { dataSources }, info) {
  if (!parent.addressId) return null
  return await dataSources.addressApi.getAddressById(parent.addressId)
}

const resolvers: IResolvers = {
  // companies,
  api: {
    company,
  },
  type: {
    Company: {
      address,
    }
  }
}

export default resolvers