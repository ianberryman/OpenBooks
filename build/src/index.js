"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const { ApolloServer } = require('apollo-server');
const typeDefs = require('./schema');
const resolvers = require('./resolvers');
const UsersApi = require('./datasources/UsersApi');
const AccountsApi = require('./datasources/AccountsApi');
process.on("SIGTERM", () => {
    server.stop();
    setTimeout(() => {
        process.exit(1);
    }, 30000);
});
const dataSources = () => ({
    usersApi: new UsersApi(),
    accountsApi: new AccountsApi()
});
const server = new ApolloServer({
    typeDefs,
    resolvers,
    dataSources
});
const context = () => __awaiter(void 0, void 0, void 0, function* () {
});
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
