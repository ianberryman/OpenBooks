import {IResolvers} from "../IResolvers";
import {Customer} from "../Customer/Customer";
import {Invoice} from "./Invoice";
import {InvoiceLineItem} from "../InvoiceLineItem/InvoiceLineItem";

async function invoice(parent, { id }, { dataSources }, info): Promise<Invoice> {
  return await dataSources.invoiceApi.getInvoiceById(id)
}

async function customer(parent: Invoice, args, { dataSources }, info): Promise<Customer> {
  if (!parent.customerId) return null
  return await dataSources.customerApi.getCustomerById(parent.customerId)
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
      lineItems,
    }
  }
}
export default resolvers