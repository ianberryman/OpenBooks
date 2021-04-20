const { ApolloServer } = require('apollo-server');
const typeDefs = require('./schema');
const resolvers = require('./resolvers');
const UsersApi = require('./datasources/UsersApi');
const AccountsApi = require('./datasources/AccountsApi');
const logger = require('../logger');

const dataSources = () => ({
    usersApi: new UsersApi(),
    accountsApi: new AccountsApi()
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
  logger.info(`Apollo Server ready at ${url}`);
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