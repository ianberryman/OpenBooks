import {DataTypes, Model} from 'sequelize'
import sequelize, {foreignKeyIdModel, idModel} from '../../datasources/db'
import {Address} from '../Address/Address'


export class ContactPerson extends Model {
    declare id: string
    declare firstName: string
    declare lastName: string
    declare addressId?: string
    declare email?: string
    declare phoneNumber?: string

    declare getAddress: () => Promise<Address>
}

ContactPerson.init({
    id: idModel(),
    firstName: {
        type: DataTypes.STRING(100),
        allowNull: false,
    },
    lastName: {
        type: DataTypes.STRING(100),
        allowNull: false,
    },
    addressId: {
        ...foreignKeyIdModel('addressId'),
    },
    email: {
        type: DataTypes.STRING(300),
    },
    phoneNumber: {
        type: DataTypes.STRING(15),
    },
}, { sequelize })
ContactPerson.hasOne(Address, { foreignKey: 'addressId', as: 'Address' })
Address.hasMany(ContactPerson, { foreignKey: 'addressId', as: 'ContactPerson' })

export type CreateContactPersonResponse = {
  success: boolean,
  contactPerson: ContactPerson,
}

export const typeDefs = `
  type ContactPerson {
    id: String!
    firstName: String
    lastName: String
    address: Address
    email: String
    phoneNumber: String
  }
  
  input CreateContactPersonInput {
    firstName: String!
    lastName: String!
    addressId: String
    email: String
    phoneNumber: String
  }
  
  type CreateContactPersonResponse {
    success: Boolean!
    contactPerson: ContactPerson
  }
`