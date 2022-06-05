

export type Invoice = {
  id: string,
  customerId: string,
  invoiceNumber: string,
  invoiceDate: string,
  dueDate: string,
  totalAmountDue: number,
}

export const typeDefs = `
  type Invoice {
    id: String!
    customer: Customer!
    invoiceNumber: String
    invoiceDate: String
    dueDate: String
    totalAmountDue: String
    lineItems: [InvoiceLineItem]
  }
`