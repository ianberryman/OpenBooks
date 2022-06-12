import sequelize, {foreignKeyIdModel, idModel} from '../../datasources/db'
import {DataTypes, Model} from 'sequelize'
import {CustomerType} from '../CustomerType'
import {Address} from '../Address/Address'
import {ContactPerson} from '../ContactPerson/ContactPerson'

export class Customer extends Model {
    declare id: string
    declare customerType: CustomerType
    declare name: string
    declare firstName: string
    declare lastName: string
    declare email: string
    declare phoneNumber: string
    declare website: string
    declare addressId: string
    declare primaryContactId: string

    declare getAddress: () => Promise<Address>
    declare getPrimaryContact: () => Promise<ContactPerson>
}

export const BusinessCustomerFields = [
    'customerType', 'name', 'website', 'addressId', 'primaryContactId'
]

export const ConsumerCustomerFields = [
    'customerType', 'firstName', 'lastName', 'email', 'website', 'phoneNumber', 'addressId'
]

Customer.init({
    id: idModel(),
    customerType: {
        type: DataTypes.ENUM(...Object.keys(CustomerType)),
        allowNull: false,
    },
    name: {
        type: DataTypes.STRING(50),
    },
    firstName: {
        type: DataTypes.STRING(50),
    },
    lastName: {
        type: DataTypes.STRING(50),
    },
    email: {
        type: DataTypes.STRING(300),
    },
    phoneNumber: {
        type: DataTypes.STRING(15),
    },
    website: {
        type: DataTypes.STRING(300),
    },
    addressId: {
        ...foreignKeyIdModel('addressId'),
    },
    primaryContactId: {
        ...foreignKeyIdModel('primaryContactId')
    }
}, { sequelize })
Customer.belongsTo(Address, { foreignKey: 'addressId', as: 'Address' })
Address.hasMany(Customer, { foreignKey: 'addressId', as: 'Customer' })
Customer.belongsTo(ContactPerson, { foreignKey: 'primaryContactId', as: 'PrimaryContact' })
ContactPerson.hasMany(Customer, { foreignKey: 'primaryContactId', as: 'Customer' })

export type CreateCustomerInput = {
  customerType: CustomerType,
  name: string,
  firstName: string,
  lastName: string,
  email: string,
  phoneNumber: string,
  website: string,
  addressId: string,
  primaryContactId: string,
}

export type CreateCustomerResponse = {
  success: boolean,
  customer: Customer,
}

export const typeDefs = `
  type Customer {
    id: String!
    customerType: CustomerType!
    name: String
    firstName: String
    lastName: String
    email: String
    phoneNumber: String
    website: String
    address: Address
    primaryContact: ContactPerson
  }
  
  input CreateCustomerInput {
    customerType: CustomerType!
    name: String
    firstName: String
    lastName: String
    website: String
    email: String
    phoneNumber: String
    addressId: String
    primaryContactId: String
  }
  
  type CreateCustomerResponse {
    success: Boolean!
    customer: Customer
  }
`