import {ApolloServer} from 'apollo-server'
import typeDefs from './schema'
import resolvers from './resolvers'
import UsersApi from './datasources/UsersApi'
import AccountApi from './datasources/AccountApi'
import AddressApi from './datasources/AddressApi'
import CompanyApi from './datasources/CompanyApi'
import ContactPersonApi from './datasources/ContactPersonApi'
import CustomerApi from './datasources/CustomerApi'
import InvoiceApi from './datasources/InvoiceApi'
import VendorApi from './datasources/VendorApi'
import BillApi from './datasources/BillApi'
import ProductApi from './datasources/ProductApi'
import TransactionApi from "./datasources/TransactionApi";
import JournalEntryApi from "./datasources/JournalEntryApi";

const dataSources = () => ({
    accountApi: new AccountApi(),
    addressApi: new AddressApi(),
    billApi: new BillApi(),
    companyApi: new CompanyApi(),
    contactPersonApi: new ContactPersonApi(),
    customerApi: new CustomerApi(),
    invoiceApi: new InvoiceApi(),
    journalEntryApi: new JournalEntryApi(),
    productApi: new ProductApi(),
    transactionApi: new TransactionApi(),
    usersApi: new UsersApi(),
    vendorApi: new VendorApi(),
})

const server = new ApolloServer({ 
    typeDefs,
    resolvers,
    dataSources,
    formatError: (error) => {
        return {
            message: error.message,
            errorCode: error.extensions.code
        }
    }
})

// eslint-disable-next-line
const context = async () => {

}

// The `listen` method launches a web server.
server.listen().then(({ url }) => {
    console.log(`Apollo Server ready at ${url}`)
})

module.exports = {
    dataSources,
    context,
    typeDefs,
    resolvers,
    ApolloServer,
    server,
}