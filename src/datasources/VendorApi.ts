import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {Vendor} from '../types/Vendor/Vendor'

export default class VendorApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createVendor(vendor: Vendor): Promise<Vendor> {
        return vendor.save()
    }


    async getVendorById(id: string): Promise<Vendor> {
        return Vendor.findByPk(idToBuffer(id))
    }
}