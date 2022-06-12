import {IResolvers} from '../IResolvers'
import {Customer} from '../Customer/Customer'
import {Invoice} from './Invoice'
import {InvoiceLineItem} from '../InvoiceLineItem/InvoiceLineItem'

async function invoice(parent, { id }, { dataSources }, info): Promise<Invoice> {
    return dataSources.invoiceApi.getInvoiceById(id)
}

async function invoices(parent, args, { dataSources }, info): Promise<Invoice> {
    return dataSources.invoiceApi.getInvoices()
}

async function customer(parent: Invoice, args, { dataSources }, info): Promise<Customer> {
    return parent.getCustomer()
}

async function totalAmountDue(parent: Invoice, args, { dataSources }, info): Promise<number> {
    const lineItems = await parent.getLineItems()

    let total = 0
    for (const lineItem of lineItems) {
        const product = await lineItem.getProduct()
        total += (lineItem.quantity * product.unitPrice) * (lineItem.discountRate ? 1 - lineItem.discountRate : 1)
    }

    return total
}

async function lineItems(parent: Invoice, args, { dataSources }, info): Promise<Array<InvoiceLineItem>> {
    return parent.getLineItems()
}

const resolvers: IResolvers = {
    api: {
        invoice,
        invoices,
    },
    type: {
        Invoice: {
            customer,
            totalAmountDue,
            lineItems,
        }
    }
}
export default resolvers