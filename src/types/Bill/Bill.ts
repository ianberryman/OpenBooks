
import sequelize, {foreignKeyIdModel, getId, idModel, setId} from '../../datasources/db'
import {DataTypes, Model} from 'sequelize'
import {Vendor} from '../Vendor/Vendor'

export class Bill extends Model {
    declare id: string
    declare vendorId: string
    declare dueDate?: string
    declare amountDue: string

    declare getVendor: () => Vendor
}

Bill.init({
    id: idModel(),
    vendorId: {
        ...foreignKeyIdModel('vendorId'),
        allowNull: false,
    },
    dueDate: {
        type: DataTypes.DATE,
    },
    amountDue: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
    }
}, { sequelize })
Bill.belongsTo(Vendor, { foreignKey: 'vendorId', as: 'Vendor' })
Vendor.hasMany(Bill, { foreignKey: 'vendorId', as: 'Bill' })

export type CreateBillResponse = {
  success: boolean,
  bill?: Bill,
}

export const typeDefs = `
  type Bill {
    id: String!
    vendor: Vendor!
    dueDate: String
    amountDue: Float!
  }
  
  input CreateBillInput {
    vendorId: String!
    dueDate: String
    amountDue: Float!
  }
  
  type CreateBillResponse {
    success: Boolean!
    bill: Bill
  }
`