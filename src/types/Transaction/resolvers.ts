import {IResolvers} from '../IResolvers'
import {Transaction} from './Transaction'
import {Account} from '../Account/Account'
import {JournalEntry} from '../JournalEntry/JournalEntry'

async function account(parent: Transaction, args, { dataSources }, info): Promise<Account> {
    return parent.getAccount()
}

async function journalEntry(parent: Transaction, args, { dataSources }, info): Promise<JournalEntry> {
    return parent.getJournalEntry()
}

const resolvers: IResolvers = {
    api: {},
    type: {
        Transaction: {
            account,
            journalEntry,
        }
    }
}
export default resolvers