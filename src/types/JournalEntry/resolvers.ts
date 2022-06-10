import {IResolvers} from "../IResolvers";
import {TransactionType} from "../TransactionType";
import {JournalEntry} from "./JournalEntry";
import {Transaction} from "../Transaction/Transaction";

async function journalEntry(parent, { id }, { dataSources }, info): Promise<JournalEntry> {
  return dataSources.journalEntryApi.getJournalEntryById(id)
}

async function credits(parent: JournalEntry, args, { dataSources }, info): Promise<Array<Transaction>> {
  return dataSources.transactionApi.getTransactionByJournalEntryIdAndType(parent.id, TransactionType.CREDIT)
}

async function debits(parent: JournalEntry, args, { dataSources }, info): Promise<Array<Transaction>> {
  return dataSources.transactionApi.getTransactionByJournalEntryIdAndType(parent.id, TransactionType.DEBIT)

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