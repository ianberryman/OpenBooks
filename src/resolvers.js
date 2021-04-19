const resolvers = {
    Query: {
      users: async (_, __, { dataSources }) => {
          const users = await dataSources.usersApi.getUsers()
          var result = users.map(user => ({
              id: user.Id,
              firstName: user.FirstName,
              lastName: user.LastName,
              email: user.Email,
              role: user.UserRole
          }));
          return result;
      }
    },
  };

module.exports = resolvers;