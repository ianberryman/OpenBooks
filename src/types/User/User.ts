import {UserRole} from '../UserRole'

export type User = {
    id: string,
    first_name: string,
    last_name: string,
    email: string,
    role: UserRole,
}

export const typeDefs = `
  type User {
    id: String!
    firstName: String!
    lastName: String!
    email: String!
    phone: String
    role: UserRole!
  }
`