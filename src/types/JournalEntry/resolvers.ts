import {IResolvers} from '../IResolvers'
import {JournalEntry} from './JournalEntry'
import {Transaction} from '../Transaction/Transaction'

async function journalEntry(parent, { id }, { dataSources }, info): Promise<JournalEntry> {
    return dataSources.journalEntryApi.getJournalEntryById(id)
}

async function credits(parent: JournalEntry, args, { dataSources }, info): Promise<Array<Transaction>> {
    return parent.getCredits()
}

async function debits(parent: JournalEntry, args, { dataSources }, info): Promise<Array<Transaction>> {
    return parent.getDebits()

}

const resolvers: IResolvers = {
    api: {
        journalEntry,
    },
    type: {
        JournalEntry: {
            credits,
            debits,
        }
    }
}
export default resolvers