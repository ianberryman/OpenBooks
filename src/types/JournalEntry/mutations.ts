import {CreateProductResponse} from "../Product/Product";
import dbPool from '../../datasources/db'
import {CreateJournalEntryResponse, JournalEntry} from "./JournalEntry";
import {TransactionType} from "../TransactionType";
import NotFoundError from "../../errors/NotFoundError";

async function createJournalEntry(_, { createJournalEntryInput }, { dataSources }): Promise<CreateJournalEntryResponse> {
  const debitTotal = createJournalEntryInput.debits.map(debit => debit.amount).reduce((prev, curr) => prev + curr)
  const creditTotal = createJournalEntryInput.credits.map(credit => credit.amount).reduce((prev, curr) => prev + curr)
  if (debitTotal !== creditTotal) {
    throw new Error(`Unbalanced Journal Entry: Debit total ${debitTotal} must equal credit total ${creditTotal}`)
  }

  // todo: this transaction is not working, likely because the internal api calls use different connections
  const journalEntryId: string = await new Promise((resolve, reject) => {
    dbPool.getConnection((err, connection) => {
      if (err) reject(err)

      connection.beginTransaction(async (err) => {
        if (err) reject(err)

        let journalEntry
        try {
          journalEntry = await dataSources.journalEntryApi.createJournalEntry(createJournalEntryInput)
          await Promise.all(createJournalEntryInput.debits.map(transaction => {
            return dataSources.transactionApi.createTransaction({...transaction, journalEntryId: journalEntry.id, type: TransactionType.DEBIT})
          }))
          await Promise.all(createJournalEntryInput.credits.map(transaction => {
            return dataSources.transactionApi.createTransaction({...transaction, journalEntryId: journalEntry.id, type: TransactionType.CREDIT})
          }))
        } catch (err) {
          connection.rollback(() => {
            console.log(err)
            reject(err)
          })
        }

        connection.commit((err) => {
          if (err) {
            connection.rollback(() => {
              console.log(err)
              reject(err)
            })
          }
        })

        resolve(journalEntry.id)
      })

      connection.release()
    })
  })

  let journalEntry
  try {
    journalEntry = await dataSources.journalEntryApi.getJournalEntryById(journalEntryId)
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new Error('Failed to create')
    }
  }

  return {
    success: true,
    journalEntry,
  }
}

const mutations = {
  createJournalEntry,
}

export default mutations