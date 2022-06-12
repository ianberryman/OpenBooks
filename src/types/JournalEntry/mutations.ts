import {CreateJournalEntryResponse} from './JournalEntry'

async function createJournalEntry(_, { createJournalEntryInput }, { dataSources }): Promise<CreateJournalEntryResponse> {
    const debitTotal = createJournalEntryInput.debits.map(debit => debit.amount).reduce((prev, curr) => prev + curr)
    const creditTotal = createJournalEntryInput.credits.map(credit => credit.amount).reduce((prev, curr) => prev + curr)
    if (debitTotal !== creditTotal) {
        throw new Error(`Unbalanced Journal Entry: Debit total ${debitTotal} must equal credit total ${creditTotal}`)
    }

    const journalEntry = await dataSources.journalEntryApi.createJournalEntry(createJournalEntryInput)

    return {
        success: true,
        journalEntry,
    }
}

const mutations = {
    createJournalEntry,
}

export default mutations