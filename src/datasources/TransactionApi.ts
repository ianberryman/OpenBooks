import { DataSource }  from 'apollo-datasource';
import {newId, query} from './db';
import NotFoundError from '../errors/NotFoundError';
import {CreateTransactionInput, Transaction} from "../types/Transaction/Transaction";
import {TransactionType} from "../types/TransactionType";

export default class TransactionApi extends DataSource {
    context: any

    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async createTransaction(input: Transaction): Promise<Transaction> {
      const id = newId()
      console.log(id)
      const { description, amount, accountId, journalEntryId, type } = input
      await query('INSERT INTO transactions SET id = unhex(?), journal_entry_id = unhex(?), account_id = unhex(?), ?',
        [
          id,
          journalEntryId,
          accountId,
          {
            description,
            amount,
            type,
          }
        ])
      return await this.getTransactionById(id)
    }

    async getTransactionById(id: string): Promise<Transaction> {
      const results = await query('SELECT hex(id) as id, hex(journal_entry_id) as journal_entry_id, hex(account_id) as account_id, type, description, amount FROM transactions WHERE id = unhex(?)', [id])

      const transaction = results[0]
      if (!transaction) throw new NotFoundError('Transaction with id: ' + id + ' not found')

      return {
        id: transaction.id,
        journalEntryId: transaction.journal_entry_id,
        accountId: transaction.account_id,
        type: transaction.type,
        description: transaction.description,
        amount: transaction.amount,
      }
    }

  async getTransactionByJournalEntryIdAndType(
    journalEntryId: string,
    type: TransactionType,
  ): Promise<Array<Transaction>> {
    const transactions = await query('SELECT hex(id) as id, hex(journal_entry_id) as journal_entry_id, hex(account_id) as account_id, type, description, amount FROM transactions WHERE journal_entry_id = unhex(?) AND type = ?', [journalEntryId, type])

    return transactions.map(transaction => ({
      id: transaction.id,
      journalEntryId: transaction.journal_entry_id,
      accountId: transaction.account_id,
      type: transaction.type,
      description: transaction.description,
      amount: transaction.amount,
    }))
  }

  async getTransactionByAccountIdAndType(
    accountId: string,
    type: TransactionType,
  ): Promise<Array<Transaction>> {
    const transactions = await query('SELECT hex(id) as id, hex(journal_entry_id) as journal_entry_id, hex(account_id) as account_id, type, description, amount FROM transactions WHERE account_id = unhex(?) AND type = ?', [accountId, type])

    return transactions.map(transaction => ({
      id: transaction.id,
      journalEntryId: transaction.journal_entry_id,
      accountId: transaction.account_id,
      type: transaction.type,
      description: transaction.description,
      amount: transaction.amount,
    }))
  }
}