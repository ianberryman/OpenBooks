import {QuantityUnit} from '../QuantityUnit'
import {DataTypes, Model} from 'sequelize'
import sequelize, {idModel} from '../../datasources/db'


export class Product extends Model {
    declare id: string
    declare name: string
    declare description?: string
    declare unitPrice: number
    declare quantityUnit: QuantityUnit
}

Product.init({
    id: idModel(),
    name: {
        type: DataTypes.STRING(50),
        allowNull: false,
    },
    description: {
        type: DataTypes.STRING(300),
    },
    unitPrice: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
    },
    quantityUnit: {
        type: DataTypes.ENUM(...Object.keys(QuantityUnit)), // should probably be normalized
        allowNull: false,
    },
}, { sequelize })

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