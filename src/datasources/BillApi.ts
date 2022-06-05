import {DataSource} from 'apollo-datasource'
import {query} from './db'
import NotFoundError from '../errors/NotFoundError'
import {Bill} from '../types/Bill/Bill'

export default class BillApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getBillById(id: string): Promise<Bill> {
        const results = await query('SELECT hex(id) as id, hex(vendor_id) as vendor_id, due_date, amount_due FROM bill WHERE id = unhex(?)', [id])

        const bill = results[0]
        if (!bill) throw new NotFoundError('Bill with id: ' + id + ' not found')

        return {
            id: bill.id,
            vendorId: bill.vendor_id,
            dueDate: bill.due_date,
            amountDue: bill.amount_due,
        }
    }
}