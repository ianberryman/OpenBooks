import {CustomerType} from "../CustomerType";


export type BusinessCustomer = {
  id: string,
  customerType: CustomerType,
  name: string,
  addressId: string,
  website: string,
  email: string,
  phone: string,
  primaryContactId: string,
}

export const typeDefs = `
  type BusinessCustomer {
    id: String!
    customerType: String!
    name: String!
    website: String
    address: Address
    email: String
    phone: String
    primaryContact: ContactPerson
  }
`