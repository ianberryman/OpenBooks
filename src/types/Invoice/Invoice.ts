

export type Invoice = {
  id: string,
  customerId: string,
  invoiceNumber: string,
  invoiceDate: string,
  dueDate: string,
}

export const typeDefs = `
  type Invoice {
    id: String!
    customer: Customer!
    invoiceNumber: String
    invoiceDate: String
    dueDate: String
    totalAmountDue: Float
    lineItems: [InvoiceLineItem]
  }
`