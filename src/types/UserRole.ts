
export enum UserRole {
    Admin = 'Admin',
    Manager = 'Manager',
    Bookkeeper = 'Bookkeeper',
}

export const typeDefs = `
  enum UserRole {
    ${Object.keys(UserRole).join('\n')}
  }
`