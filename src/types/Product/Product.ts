import {QuantityUnit} from '../QuantityUnit'


export type Product = {
  id: string,
  name: string,
  description?: string,
  unitPrice: number,
  quantityUnit: QuantityUnit,
}

export type CreateProductInput = {
  name: string,
  description?: string,
  unitPrice: number,
  quantityUnit: QuantityUnit,
}

export type CreateProductResponse = {
  success: boolean,
  product?: Product,
}

export type UpdateProductInput = {
  id: string,
  name: string,
  description?: string,
  unitPrice: number,
  quantityUnit: QuantityUnit,
}

export type UpdateProductResponse = {
  success: boolean,
  product?: Product,
}

export type DeleteProductResponse = {
  success: boolean,
}

export const typeDefs = `
  type Product {
    id: String!
    name: String!
    description: String
    unitPrice: Float!
    quantityUnit: QuantityUnit!
  }
  input CreateProductInput {
    name: String!
    description: String
    unitPrice: Float!
    quantityUnit: QuantityUnit!
  }
  type CreateProductResponse {
    success: Boolean!
    product: Product
  }
  input UpdateProductInput {
    id: String!
    name: String!
    description: String
    unitPrice: Float!
    quantityUnit: QuantityUnit!
  }
  type UpdateProductResponse {
    success: Boolean!
    product: Product
  }
  type DeleteProductResponse {
    success: Boolean!
  }
`