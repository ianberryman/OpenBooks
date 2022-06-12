import {DataTypes, Model} from 'sequelize'
import sequelize, {foreignKeyIdModel, idModel} from '../../datasources/db'
import {Bill} from '../Bill/Bill'
import {Address} from '../Address/Address'
import {ContactPerson} from '../ContactPerson/ContactPerson'


export class Vendor extends Model {
    declare id: string
    declare name: string
    declare website?: string
    declare addressId?: string
    declare primaryContactId?: string

    declare getBills: () => Promise<Array<Bill>>
}

Vendor.init({
    id: idModel(),
    name: {
        type: DataTypes.STRING(50),
        allowNull: false,
    },
    website: {
        type: DataTypes.STRING(255),
    },
    addressId: {
        ...foreignKeyIdModel('addressId'),
    },
    primaryContactId: {
        ...foreignKeyIdModel('primaryContactId'),
    },
}, { sequelize })
Vendor.hasOne(Address, { foreignKey: 'addressId', as: 'Address' })
Address.hasMany(Vendor, { foreignKey: 'addressId', as: 'Vendor' })
Vendor.hasOne(ContactPerson, { foreignKey: 'contactPersonId', as: 'ContactPerson' })
ContactPerson.hasMany(Vendor, { foreignKey: 'contactPersonId', as: 'Vendor' })

export type CreateVendorResponse = {
  success: boolean,
  vendor: Vendor,
}

export const typeDefs = `
  type Vendor {
    id: String!
    name: String!
    website: String
    address: Address
    primaryContact: ContactPerson
  }
  
  input CreateVendorInput {
    name: String!
    website: String
    addressId: String
    primaryContactId: String
  }
  
  type CreateVendorResponse {
    success: Boolean!
    vendor: Vendor
  }
`