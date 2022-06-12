import {CreateInvoiceResponse} from './Invoice'

async function createInvoice(_, { createInvoiceInput }, { dataSources }): Promise<CreateInvoiceResponse> {
    const invoice = await dataSources.invoiceApi.createInvoice(createInvoiceInput)
    return {
        success: true,
        invoice,
    }
}

const mutations = {
    createInvoice,
}

export default mutations