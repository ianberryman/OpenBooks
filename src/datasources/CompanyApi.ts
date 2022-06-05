import { DataSource }  from 'apollo-datasource'
import { query } from './db'
import NotFoundError from '../errors/NotFoundError'
import {Company} from '../types/Company/Company'

export default class CompanyApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getCompanyById(id: string): Promise<Company> {
        const results = await query('SELECT hex(id) as id, company_name, tax_id, tax_id_type, hex(address_id) as address_id, website FROM company WHERE id = unhex(?)', [id])

        const company = results[0]
        if (!company) throw new NotFoundError('Company with id: ' + id + ' not found')

        return {
            id: company.id,
            name: company.company_name,
            taxId: company.tax_id,
            taxIdType: company.tax_id_type,
            addressId: company.address_id,
            websiteUrl: company.website,
        }
    }
}