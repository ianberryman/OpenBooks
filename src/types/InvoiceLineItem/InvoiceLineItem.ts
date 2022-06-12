import {DataTypes, Model} from 'sequelize'
import sequelize, {foreignKeyIdModel} from '../../datasources/db'
import {Invoice} from '../Invoice/Invoice'
import {Product} from '../Product/Product'

export class InvoiceLineItem extends Model {
    declare invoiceId: string
    declare lineNumber: number
    declare description?: string
    declare quantity: number
    declare productId: string
    declare discountRate?: number

    declare getProduct: () => Promise<Product>
}

InvoiceLineItem.init({
    invoiceId: {
        ...foreignKeyIdModel('invoiceId'),
        allowNull: false,
    },
    lineNumber: {
        type: DataTypes.INTEGER,
        allowNull: false,
    },
    description: {
        type: DataTypes.STRING(150),
    },
    quantity: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0,
    },
    discountRate: {
        type: DataTypes.DECIMAL(3,2),
    },
    productId: {
        ...foreignKeyIdModel('productId'),
        allowNull: false,
    }
}, { sequelize })
InvoiceLineItem.belongsTo(Invoice, { foreignKey: 'invoiceId' })
Invoice.InvoiceLineItem = Invoice.hasMany(InvoiceLineItem, { foreignKey: 'invoiceId', as: 'lineItems' })
InvoiceLineItem.belongsTo(Product, { foreignKey: 'productId' })
Product.hasMany(InvoiceLineItem, { foreignKey: 'productId' })

export type CreateInvoiceLineItemInput = {
  lineNumber: number,
  description: string,
  quantity: number,
  productId: string,
  discountRate: number,
}

export const typeDefs = `
  type InvoiceLineItem {
    invoiceId: String!
    lineNumber: Int!
    description: String
    quantity: Int!
    product: Product!
    discountRate: Float
  }
  
  input CreateInvoiceLineItemInput {
    lineNumber: Int!
    description: String
    quantity: Int!
    productId: String!
    discountRate: Float 
  }
`