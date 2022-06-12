import {TaxIdType} from '../TaxIdType'
import {DataTypes, Model} from 'sequelize'
import sequelize, {foreignKeyIdModel, idModel} from '../../datasources/db'
import {Address} from '../Address/Address'


export class Company extends Model {
    declare id: string
    declare name: string
    declare taxId?: string
    declare taxIdType?: TaxIdType
    declare addressId?: string
    declare website?: string

    declare getAddress: () => Promise<Address>
}

Company.init({
    id: idModel(),
    name: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
    },
    taxId: {
        type: DataTypes.STRING(10)
    },
    taxIdType: {
        type: DataTypes.ENUM(...Object.keys(TaxIdType)),
    },
    website: {
        type: DataTypes.STRING(300),
    },
    addressId: {
        ...foreignKeyIdModel('addressId'),
    },
}, {
    sequelize,
    validate: {
        taxIdTypeNotNull() {
            if (this.taxId && !this.taxIdType) {
                throw new Error('taxIdType is required when taxId is provided')
            }
        }
    },
})
Company.belongsTo(Address, { foreignKey: 'addressId', as: 'Address' })
Address.hasMany(Company, { foreignKey: 'addressId', as: 'Company' })

export type CreateCompanyInput = {
  name: string,
  taxId: string,
  taxIdType: TaxIdType,
  addressId: string,
  website: string,
}

export type CreateCompanyResponse = {
  success: boolean,
  company: Company,
}

export const typeDefs = `
  type Company {
    id: String!
    name: String!
    taxId: String
    taxIdType: TaxIdType
    address: Address
    website: String
  }
  
  input CreateCompanyInput {
    name: String!
    taxId: String
    taxIdType: TaxIdType
    addressId: String
    website: String
  }
  
  type CreateCompanyResponse {
    success: Boolean!
    company: Company
  }
`