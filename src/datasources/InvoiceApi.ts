import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {CreateInvoiceInput, Invoice} from '../types/Invoice/Invoice'
import {InvoiceLineItem} from '../types/InvoiceLineItem/InvoiceLineItem'

export default class InvoiceApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createInvoice(invoiceInput: CreateInvoiceInput): Promise<Invoice> {
        return Invoice.create(invoiceInput, { include: [{association: Invoice.InvoiceLineItem}] })
    }

    async getInvoiceById(id: string): Promise<Invoice> {
        return Invoice.findByPk(idToBuffer(id))
    }

    async getInvoices(): Promise<Array<Invoice>> {
        return Invoice.findAll()
    }
}