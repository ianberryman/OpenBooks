import {TaxIdType} from '../TaxIdType'


export type Company = {
  id: string,
  name: string,
  taxId?: string,
  taxIdType?: TaxIdType,
  addressId?: string,
  websiteUrl?: string,
}

export const typeDefs = `
  type Company {
    id: String!
    name: String!
    taxId: String
    taxIdType: TaxIdType
    address: Address
    websiteUrl: String
  }
`