
import AccountResolvers from './types/Account/resolvers'
import AddressResolvers from './types/Address/resolvers'
import BillResolvers from './types/Bill/resolvers'
import BusinessCustomerResolvers from './types/BusinessCustomer/resolvers'
import CompanyResolvers from './types/Company/resolvers'
import ConsumerCustomerResolvers from './types/ConsumerCustomer/resolvers'
import ContactPersonResolvers from './types/ContactPerson/resolvers'
import CustomerResolvers from './types/Customer/resolvers'
import InvoiceResolvers from './types/Invoice/resolvers'
import InvoiceLineItemResolvers from './types/InvoiceLineItem/resolvers'
import JournalEntryResolvers from './types/JournalEntry/resolvers'
import JournalEntryMutations from './types/JournalEntry/mutations'
import ProductMutations from './types/Product/mutations'
import ProductResolvers from './types/Product/resolvers'
import TransactionResolvers from './types/Transaction/resolvers'
import UserResolvers from './types/User/resolvers'
import VendorResolvers from './types/Vendor/resolvers'


const resolvers = {
    Query: {
        ...AccountResolvers.api,
        ...AddressResolvers.api,
        ...BillResolvers.api,
        ...BusinessCustomerResolvers.api,
        ...CompanyResolvers.api,
        ...ConsumerCustomerResolvers.api,
        ...ContactPersonResolvers.api,
        ...CustomerResolvers.api,
        ...InvoiceResolvers.api,
        ...InvoiceLineItemResolvers.api,
        ...JournalEntryResolvers.api,
        ...ProductResolvers.api,
        ...TransactionResolvers.api,
        ...UserResolvers.api,
        ...VendorResolvers.api,
    },

    Mutation: {
        ...JournalEntryMutations,
        ...ProductMutations,
    },

    ...AccountResolvers.type,
    ...AddressResolvers.type,
    ...BillResolvers.type,
    ...BusinessCustomerResolvers.type,
    ...CompanyResolvers.type,
    ...ConsumerCustomerResolvers.type,
    ...ContactPersonResolvers.type,
    ...CustomerResolvers.type,
    ...InvoiceResolvers.type,
    ...InvoiceLineItemResolvers.type,
    ...JournalEntryResolvers.type,
    ...TransactionResolvers.type,
    ...UserResolvers.type,
    ...ProductResolvers.type,
    ...VendorResolvers.type,
}

export default resolvers