import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {Company, CreateCompanyInput} from '../types/Company/Company'

export default class CompanyApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createCompany(companyInput: CreateCompanyInput): Promise<Company> {
        return Company.create(companyInput)
    }

    async getCompanyById(id: string): Promise<Company> {
        return Company.findByPk(idToBuffer(id))
    }

    async getCompanies(): Promise<Array<Company>> {
        return Company.findAll()
    }
}