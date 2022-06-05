

export type Bill = {
  id: string,
  vendorId: string,
  dueDate?: string,
  amountDue: string,
}

export const typeDefs = `
  type Bill {
    id: String!
    vendor: Vendor!
    dueDate: String
    amountDue: String!
  }
`