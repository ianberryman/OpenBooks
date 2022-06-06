import { DataSource }  from 'apollo-datasource'
import { query } from './db'
import NotFoundError from '../errors/NotFoundError'
import {Invoice} from '../types/Invoice/Invoice'
import {InvoiceLineItem} from '../types/InvoiceLineItem/InvoiceLineItem'

export default class InvoiceApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async getInvoiceById(id: string): Promise<Invoice> {
        const results = await query('SELECT hex(id) as id, hex(customer_id) as customer_id, invoice_number, invoice_date, due_date FROM invoice WHERE id = unhex(?)', [id])

        const invoice = results[0]
        if (!invoice) throw new NotFoundError('Invoice with id: ' + id + ' not found')

        return {
            id: invoice.id,
            customerId: invoice.customer_id,
            invoiceNumber: invoice.invoice_number,
            invoiceDate: invoice.invoice_date,
            dueDate: invoice.due_date,
        }
    }

    async getInvoiceLineItemsByInvoiceId(invoiceId: string): Promise<Array<InvoiceLineItem>> {
        const lineItems = await query('SELECT hex(invoice_id) as invoice_id, line_number, item_name, description, quantity, hex(product_id) as product_id, discount_rate FROM invoice_line_item WHERE invoice_id = unhex(?)', [invoiceId])

        return lineItems.map(lineItem => ({
            invoiceId: lineItem.invoice_id,
            lineNumber: lineItem.line_number,
            itemName: lineItem.item_name,
            description: lineItem.description,
            quantity: lineItem.quantity,
            productId: lineItem.product_id,
            discountRate: lineItem.discount_rate,
        }))
    }
}