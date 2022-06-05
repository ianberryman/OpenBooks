import { DataSource }  from 'apollo-datasource'
import { query } from './db'
import NotFoundError from '../errors/NotFoundError'
import {Vendor} from '../types/Vendor/Vendor'

export default class VendorApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getVendorById(id: string): Promise<Vendor> {
        const results = await query('SELECT hex(id) as id, vendor_name, website, hex(address_id) as address_id, hex(primary_contact_id) as primary_contact_id FROM vendor WHERE id = unhex(?)', [id])
        const vendor = results[0]
        if (!vendor) throw new NotFoundError('Vendor with id: ' + id + ' not found')

        return {
            id: vendor.id,
            name: vendor.vendor_name,
            website: vendor.website,
            addressId: vendor.address_id,
            primaryContactId: vendor.primary_contact_id,
        }
    }
}