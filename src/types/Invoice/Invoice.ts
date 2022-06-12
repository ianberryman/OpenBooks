import {DataTypes, HasMany, Model} from 'sequelize'
import sequelize, {foreignKeyIdModel, idModel} from '../../datasources/db'
import {Customer} from '../Customer/Customer'
import {CreateInvoiceLineItemInput, InvoiceLineItem} from '../InvoiceLineItem/InvoiceLineItem'

export class Invoice extends Model {
    declare id: string
    declare customerId: string
    declare invoiceNumber: string
    declare invoiceDate: string
    declare dueDate: string

    static InvoiceLineItem: HasMany<Invoice, InvoiceLineItem>

    declare getLineItems: () => Promise<Array<InvoiceLineItem>>
    declare getCustomer: () => Promise<Customer>
}

Invoice.init({
    id: idModel(),
    customerId: {
        ...foreignKeyIdModel('customerId')
    },
    invoiceNumber: {
        type: DataTypes.STRING(20),
        allowNull: false,
    },
    invoiceDate: {
        type: DataTypes.DATE,
    },
    dueDate: {
        type: DataTypes.DATE,
    }
}, { sequelize })
Invoice.belongsTo(Customer, { foreignKey: 'customerId', as: 'Customer' })
Customer.hasMany(Invoice, { foreignKey: 'customerId', as: 'Invoice'})

export type CreateInvoiceInput = {
  customerId: string,
  invoiceNumber: string,
  invoiceDate: string,
  dueDate: string,
  lineItems: Array<CreateInvoiceLineItemInput>,
}

export type CreateInvoiceResponse = {
  success: boolean,
  invoice: Invoice,
}

export const typeDefs = `
  type Invoice {
    id: String!
    customer: Customer!
    invoiceNumber: String!
    invoiceDate: String
    dueDate: String
    totalAmountDue: Float
    lineItems: [InvoiceLineItem!]!
  }
  
  input CreateInvoiceInput {
    customerId: String!
    invoiceNumber: String!
    invoiceDate: String
    dueDate: String
    lineItems: [CreateInvoiceLineItemInput!]!
  }
  
  type CreateInvoiceResponse {
    success: Boolean!
    invoice: Invoice
  }
`