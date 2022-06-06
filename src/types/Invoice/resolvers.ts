import {IResolvers} from '../IResolvers'
import {Customer} from '../Customer/Customer'
import {Invoice} from './Invoice'
import {InvoiceLineItem} from '../InvoiceLineItem/InvoiceLineItem'

async function invoice(parent, { id }, { dataSources }, info): Promise<Invoice> {
    return await dataSources.invoiceApi.getInvoiceById(id)
}

async function customer(parent: Invoice, args, { dataSources }, info): Promise<Customer> {
    if (!parent.customerId) return null
    return await dataSources.customerApi.getCustomerById(parent.customerId)
}

async function totalAmountDue(parent: Invoice, args, { dataSources }, info): Promise<number> {
    const lineItems = await dataSources.invoiceApi.getInvoiceLineItemsByInvoiceId(parent.id)

    let total = 0
    for (const lineItem of lineItems) {
        const product = await dataSources.productApi.getProductById(lineItem.productId)
        total += (lineItem.quantity * product.unitPrice) * (lineItem.discountRate ? 1 - lineItem.discountRate : 1)
    }

    return total
}

async function lineItems(parent: Invoice, args, { dataSources }, info): Promise<Array<InvoiceLineItem>> {
    return await dataSources.invoiceApi.getInvoiceLineItemsByInvoiceId(parent.id)
}

const resolvers: IResolvers = {
    api: {
        invoice,
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