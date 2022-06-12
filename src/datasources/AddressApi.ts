import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {Address} from '../types/Address/Address'

export default class AddressApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createAddress(address: Address): Promise<Address> {
        return address.save()
    }

    async getAddressById(id: string): Promise<Address> {
        return Address.findByPk(idToBuffer(id))
    }
}