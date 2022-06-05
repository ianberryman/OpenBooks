import {QuantityUnit} from "../QuantityUnit";

export type InvoiceLineItem = {
  invoiceId: string,
  lineNumber: number,
  itemName: string,
  description?: string,
  quantity: number,
  quantityUnit: QuantityUnit,
  pricePerUnit: number
}

export const typeDefs = `
  type InvoiceLineItem {
    lineNumber: Int!
    itemName: String!
    description: String
    quantity: Float!
    quantityUnit: QuantityUnit!
    pricePerUnit: Float!
  }
`