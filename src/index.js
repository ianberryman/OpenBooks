const { ApolloServer } = require('apollo-server');
const typeDefs = require('./schema');
const resolvers = require('./resolvers');
const UsersApi = require('./datasources/UsersApi');

const dataSources = () => ({
    usersApi: new UsersApi()
});

const server = new ApolloServer({ 
    typeDefs, 
    resolvers,
    dataSources
});

const context = async () => {

}

// The `listen` method launches a web server.
server.listen().then(({ url }) => {
  console.log(`🚀  Server ready at ${url}`);
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