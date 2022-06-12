
import AccountMutations from './types/Account/mutations'
import AccountResolvers from './types/Account/resolvers'
import AddressMutations from './types/Address/mutations'
import AddressResolvers from './types/Address/resolvers'
import BillMutations from './types/Bill/mutations'
import BillResolvers from './types/Bill/resolvers'
import CompanyMutations from './types/Company/mutations'
import CompanyResolvers from './types/Company/resolvers'
import ContactPersonMutations from './types/ContactPerson/mutations'
import ContactPersonResolvers from './types/ContactPerson/resolvers'
import CustomerMutations from './types/Customer/mutations'
import CustomerResolvers from './types/Customer/resolvers'
import InvoiceMutations from './types/Invoice/mutations'
import InvoiceResolvers from './types/Invoice/resolvers'
import InvoiceLineItemResolvers from './types/InvoiceLineItem/resolvers'
import JournalEntryResolvers from './types/JournalEntry/resolvers'
import JournalEntryMutations from './types/JournalEntry/mutations'
import ProductMutations from './types/Product/mutations'
import ProductResolvers from './types/Product/resolvers'
import TransactionResolvers from './types/Transaction/resolvers'
import UserMutations from './types/User/mutations'
import UserResolvers from './types/User/resolvers'
import VendorMutations from './types/Vendor/mutations'
import VendorResolvers from './types/Vendor/resolvers'


const resolvers = {
    Query: {
        ...AccountResolvers.api,
        ...AddressResolvers.api,
        ...BillResolvers.api,
        ...CompanyResolvers.api,
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
        ...AccountMutations,
        ...AddressMutations,
        ...BillMutations,
        ...CompanyMutations,
        ...ContactPersonMutations,
        ...CustomerMutations,
        ...InvoiceMutations,
        ...JournalEntryMutations,
        ...ProductMutations,
        ...UserMutations,
        ...VendorMutations,
    },

    ...AccountResolvers.type,
    ...AddressResolvers.type,
    ...BillResolvers.type,
    ...CompanyResolvers.type,
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