

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
      account: async (_, args, { dataSources }) => {
        return await dataSources.accountsApi.getAccountById(args.id);
      },
    },
  };

module.exports = resolvers;