
export type Address = {
  id: string,
  line1: string,
  line2: string,
  city: string,
  state: string,
  zipcode: string,
  country: string,
}

export const typeDefs = `
  type Address {
    id: String!
    line1: String
    line2: String
    city: String
    state: String
    zipcode: String
    country: String
  }
`