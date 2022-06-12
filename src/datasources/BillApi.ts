import {DataSource} from 'apollo-datasource'
import {Bill} from '../types/Bill/Bill'
import {idToBuffer} from './db'

export default class BillApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createBill(bill: Bill): Promise<Bill> {
        return bill.save()
    }

    async getBillById(id: string): Promise<Bill> {
        return Bill.findByPk(idToBuffer(id))
    }
}