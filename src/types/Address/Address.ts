import {DataTypes, Model} from 'sequelize'
import sequelize, {idModel} from '../../datasources/db'

export class Address extends Model {
    declare id: string
    declare line1: string
    declare line2: string
    declare city: string
    declare state: string
    declare zipcode: string
    declare country: string
}

Address.init({
    id: idModel(),
    line1: {
        type: DataTypes.STRING(100)
    },
    line2: {
        type: DataTypes.STRING(100)
    },
    city: {
        type: DataTypes.STRING(100)
    },
    state: {
        type: DataTypes.STRING(40)
    },
    postalCode: {
        type: DataTypes.STRING(20)
    },
    country: {
        type: DataTypes.STRING(2)
    },
}, { sequelize })

export type CreateAddressResponse = {
  success: boolean,
  address: Address,
}

export const typeDefs = `
  type Address {
    id: String!
    line1: String
    line2: String
    city: String
    state: String
    zipcode: String
    country: String
  }
  
  input CreateAddressInput {
    line1: String
    line2: String
    city: String
    state: String
    zipcode: String
    country: String
  }
  
  type CreateAddressResponse {
    success: Boolean!
    address: Address
  }
`