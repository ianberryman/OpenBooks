import {DataSource} from 'apollo-datasource'
import {idToBuffer} from './db'
import {CreateTransactionInput, Transaction} from '../types/Transaction/Transaction'
import {TransactionType} from '../types/TransactionType'

export default class TransactionApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createTransaction(transactionInput: CreateTransactionInput): Promise<Transaction> {
        return Transaction.create(transactionInput)
    }

    async getTransactionById(id: string): Promise<Transaction> {
        return Transaction.findByPk(idToBuffer(id))
    }

    async getTransactionByJournalEntryIdAndType(
        journalEntryId: string,
        type: TransactionType,
    ): Promise<Array<Transaction>> {
        return Transaction.findAll({ where: { journalyEntryId: journalEntryId, type: type } })
    }

    async getTransactionByAccountIdAndType(
        accountId: string,
        type: TransactionType,
    ): Promise<Array<Transaction>> {
        return Transaction.findAll({ where: { accountId: accountId, type: type } })
    }
}