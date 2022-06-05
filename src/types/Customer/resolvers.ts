import {IResolvers} from "../IResolvers";
import {Customer} from "./Customer";

async function customer(parent, { id }, { dataSources }, info): Promise<Customer> {
  return await dataSources.customerApi.getCustomerById(id)
}

async function __resolveType(customer: Customer, __, { dataSources }) {
  return `${customer.customerType}Customer`
}

const resolvers: IResolvers = {
  api: {
    customer,
  },
  type: {
    Customer: {
      __resolveType,
    }
  }
}
export default resolvers