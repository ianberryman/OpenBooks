

const resolvers = {
    Query: {
      users: async (_, __, { dataSources }) => {
          const users = await dataSources.usersApi.getUsers()
          var result = users.map(user => ({
              id: user.id,
              firstName: user.first_name,
              lastName: user.last_name,
              email: user.email,
              role: user.user_role
          }));
          return result;
      },
      accounts: async (_, __, { dataSources }) => {
        return await dataSources.accountsApi.getAccounts();
      },
      account: async (_, { id }, { dataSources }) => {
        return await dataSources.accountsApi.getAccountById(id);
      },
      exchangeRates: async (_, { currency }, { dataSources }) => {
        return await dataSources.exchangeRatesApi.getExchangeRatesByCurrency(currency);
      }
    },
    Mutation: {
      changeExchangeRateForCurrency: async (_, { currency, newRate }, { dataSources }) => {
        return await dataSources.exchangeRatesApi.changeExchangeRateForCurrency(currency, newRate);
      }
    },
    Customer: {
        __resolveType: async (customer, __, { dataSources }) => {
            return customer.customerType
        }
    }
};
export default resolvers