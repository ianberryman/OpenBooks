export type InvoiceLineItem = {
  invoiceId: string,
  lineNumber: number,
  description?: string,
  quantity: number,
  productId: string,
  discountRate?: number,
}

export const typeDefs = `
  type InvoiceLineItem {
    lineNumber: Int!
    description: String
    quantity: Int!
    product: Product!
    discountRate: Float
  }
`