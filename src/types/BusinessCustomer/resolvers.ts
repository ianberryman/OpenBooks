import {IResolvers} from "../IResolvers";
import {ConsumerCustomer} from "../ConsumerCustomer/ConsumerCustomer";
import {Address} from "../Address/Address";
import {ContactPerson} from "../ContactPerson/ContactPerson";

async function address(parent: ConsumerCustomer, args, { dataSources }, info): Promise<Address> {
  if (!parent.addressId) return null
  return await dataSources.addressApi.getAddressById(parent.addressId)
}

async function primaryContact(parent: ConsumerCustomer, args, { dataSources }, info): Promise<ContactPerson> {
  if (!parent.primaryContactId) return null
  return await dataSources.contactPersonApi.getContactPersonById(parent.primaryContactId)
}

const resolvers: IResolvers = {
  api: {},
  type: {
    BusinessCustomer: {
      address,
      primaryContact,
    }
  }
}
export default resolvers