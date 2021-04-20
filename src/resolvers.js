const NotFoundError = require('./errors/NotFoundError');

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
        const accounts = await dataSources.accountsApi.getAccounts()
        var result = accounts.map(account => ({
            id: account.id,
            name: account.account_name,
            accountType: account.account_type,
            balance: account.balance,
            isSystemAccount: account.is_system_account
        }));
        return result;
      },
      account: async (_, args, { dataSources }) => {
        const account = await dataSources.accountsApi.getAccountById(args.id);
        if (!account) throw new NotFoundError("Account with ID " + args.id + " not found");
        var result = {
            id: account.id,
            name: account.account_name,
            accountType: account.account_type,
            balance: account.balance,
            isSystemAccount: account.is_system_account
          };
        return result;
      },
    },
  };

module.exports = resolvers;