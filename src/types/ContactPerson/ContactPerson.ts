

export type ContactPerson = {
  id: string,
  firstName: string,
  lastName: string,
  addressId?: string,
  email?: string,
  phoneNumber?: string,
}

export const typeDefs = `
  type ContactPerson {
    id: String!
    firstName: String
    lastName: String
    address: Address
    email: String
    phoneNumber: String
  }
`