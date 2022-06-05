
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
import UserResolvers from './types/User/resolvers'
import VendorResolvers from './types/Vendor/resolvers'


const resolvers = {
    Query: {
        ...AccountResolvers.api,
        ...AddressResolvers.api,
        ...BillResolvers.api,
        ...CompanyResolvers.api,
        ...CustomerResolvers.api,
        ...InvoiceResolvers.api,
        ...UserResolvers.api,
        ...VendorResolvers.api,
    },

    // Mutation: {
    // },

    ...BillResolvers.type,
    ...BusinessCustomerResolvers.type,
    ...CompanyResolvers.type,
    ...ConsumerCustomerResolvers.type,
    ...ContactPersonResolvers.type,
    ...CustomerResolvers.type,
    ...InvoiceResolvers.type,
    ...InvoiceLineItemResolvers.type,
    ...VendorResolvers.type,
}

export default resolvers