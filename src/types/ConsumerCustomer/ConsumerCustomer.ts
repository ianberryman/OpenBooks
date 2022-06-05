import {CustomerType} from "../CustomerType";


export type ConsumerCustomer = {
  id: string,
  customerType: CustomerType,
  firstName: string,
  lastName: string,
  addressId?: string,
  website?: string,
  email?: string,
  phone?: string,
  primaryContactId?: string,
}

export const typeDefs = `
  type ConsumerCustomer {
    id: String!
    customerType: CustomerType!
    firstName: String!
    lastName: String!
    address: Address
    email: String
    phone: String
    primaryContact: ContactPerson
  }
`