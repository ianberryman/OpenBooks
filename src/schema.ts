
import { gql } from 'apollo-server'
import * as Account from './types/Account/Account'
import * as AccountType from './types/AccountType'
import * as Address from './types/Address/Address'
import * as Bill from './types/Bill/Bill'
import * as BusinessCustomer from './types/BusinessCustomer/BusinessCustomer'
import * as Company from './types/Company/Company'
import * as ConsumerCustomer from './types/ConsumerCustomer/ConsumerCustomer'
import * as ContactPerson from './types/ContactPerson/ContactPerson'
import * as Customer from './types/Customer/Customer'
import * as CustomerType from './types/CustomerType'
import * as Invoice from './types/Invoice/Invoice'
import * as InvoiceLineItem from './types/InvoiceLineItem/InvoiceLineItem'
import * as QuantityUnit from './types/QuantityUnit'
import * as TaxIdType from './types/TaxIdType'
import * as User from './types/User/User'
import * as UserRole from './types/UserRole'
import * as Vendor from './types/Vendor/Vendor'

const typeDefs = gql `
  ${Account.typeDefs}
  ${AccountType.typeDefs}
  ${Address.typeDefs}
  ${Bill.typeDefs}
  ${BusinessCustomer.typeDefs}
  ${Company.typeDefs}
  ${ConsumerCustomer.typeDefs}
  ${ContactPerson.typeDefs}
  ${Customer.typeDefs}
  ${CustomerType.typeDefs}
  ${Invoice.typeDefs}
  ${InvoiceLineItem.typeDefs}
  ${QuantityUnit.typeDefs}
  ${TaxIdType.typeDefs}
  ${User.typeDefs}
  ${UserRole.typeDefs}
  ${Vendor.typeDefs}

  type Query {
    users: [User]
    user(id: String!): User
    accounts: [Account]
    account(id: String!): Account
    address(id: String!): Address
    bill(id: String!): Bill
    company(id: String!): Company
    customer(id: String!): Customer
    invoice(id: String!): Invoice
    vendor(id: String!): Vendor
  }

  
`
//type Mutation {}
export default typeDefs
