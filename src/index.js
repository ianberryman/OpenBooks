import { ApolloServer } from 'apollo-server';
import typeDefs from './schema';
import resolvers  from './resolvers';
import UsersApi from './datasources/UsersApi';
import AccountsApi from './datasources/AccountsApi';
import ExchangeRatesApi from './datasources/ExchangeRatesApi';

const dataSources = () => ({
    usersApi: new UsersApi(),
    accountsApi: new AccountsApi(),
    exchangeRatesApi: new ExchangeRatesApi()
});

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
});

const context = async () => {

}

// The `listen` method launches a web server.
server.listen().then(({ url }) => {
  console.log(`Apollo Server ready at ${url}`);
});

// export all the important pieces for integration/e2e tests to use
module.exports = {
    dataSources,
    context,
    typeDefs,
    resolvers,
    ApolloServer,
    server,
  };