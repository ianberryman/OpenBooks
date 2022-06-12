
import { gql } from 'apollo-server'
import * as Account from './types/Account/Account'
import * as AccountType from './types/AccountType'
import * as Address from './types/Address/Address'
import * as Bill from './types/Bill/Bill'
import * as Company from './types/Company/Company'
import * as ContactPerson from './types/ContactPerson/ContactPerson'
import * as Customer from './types/Customer/Customer'
import * as CustomerType from './types/CustomerType'
import * as Invoice from './types/Invoice/Invoice'
import * as InvoiceLineItem from './types/InvoiceLineItem/InvoiceLineItem'
import * as JournalEntry from './types/JournalEntry/JournalEntry'
import * as Product from './types/Product/Product'
import * as QuantityUnit from './types/QuantityUnit'
import * as TaxIdType from './types/TaxIdType'
import * as Transaction from './types/Transaction/Transaction'
import * as TransactionType from './types/TransactionType'
import * as User from './types/User/User'
import * as UserRole from './types/UserRole'
import * as Vendor from './types/Vendor/Vendor'

const typeDefs = gql `
  ${Account.typeDefs}
  ${AccountType.typeDefs}
  ${Address.typeDefs}
  ${Bill.typeDefs}
  ${Company.typeDefs}
  ${ContactPerson.typeDefs}
  ${Customer.typeDefs}
  ${CustomerType.typeDefs}
  ${Invoice.typeDefs}
  ${InvoiceLineItem.typeDefs}
  ${JournalEntry.typeDefs}
  ${Product.typeDefs}
  ${QuantityUnit.typeDefs}
  ${TaxIdType.typeDefs}
  ${Transaction.typeDefs}
  ${TransactionType.typeDefs}
  ${User.typeDefs}
  ${UserRole.typeDefs}
  ${Vendor.typeDefs}
  
  type Mutation {
    createAccount(createAccountInput: CreateAccountInput!): CreateAccountResponse!
    
    createAddress(createAddressInput: CreateAddressInput!): CreateAddressResponse!
    
    createBill(createBillInput: CreateBillInput!): CreateBillResponse!
    
    createCompany(createCompanyInput: CreateCompanyInput!): CreateCompanyResponse!
    
    createContactPerson(createContactPersonInput: CreateContactPersonInput!): CreateContactPersonResponse!
    
    createCustomer(createCustomerInput: CreateCustomerInput!): CreateCustomerResponse!
    
    createInvoice(createInvoiceInput: CreateInvoiceInput!): CreateInvoiceResponse!
  
    createJournalEntry(createJournalEntryInput: CreateJournalEntryInput!): CreateJournalEntryResponse!
  
    createProduct(createProductInput: CreateProductInput!): CreateProductResponse!
    updateProduct(updateProductInput: UpdateProductInput!): UpdateProductResponse!
    deleteProduct(id: String!): DeleteProductResponse!
    
    createUser(createUserInput: CreateUserInput!): CreateUserResponse!
    
    createVendor(createVendorInput: CreateVendorInput!): CreateVendorResponse!
  }
  type Query {
    accounts: [Account]
    account(id: String!): Account
    address(id: String!): Address
    bill(id: String!): Bill
    company(id: String!): Company
    companies: [Company]
    customer(id: String!): Customer
    customers: [Customer]
    invoice(id: String!): Invoice
    invoices: [Invoice]
    journalEntry(id: String!): JournalEntry
    products: [Product]
    users: [User]
    user(id: String!): User
    vendor(id: String!): Vendor
  }
`
export default typeDefs
