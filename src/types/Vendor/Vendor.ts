

export type Vendor = {
  id: string,
  name: string,
  website?: string,
  addressId?: string,
  primaryContactId?: string,
}

export const typeDefs = `
  type Vendor {
    id: String!
    name: String!
    website: String
    address: Address
    primaryContact: ContactPerson
  }
`