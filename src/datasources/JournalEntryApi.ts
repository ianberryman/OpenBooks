import {DataSource} from 'apollo-datasource'
import sequelize, {idToBuffer} from './db'
import {CreateJournalEntryInput, JournalEntry} from '../types/JournalEntry/JournalEntry'

export default class JournalEntryApi extends DataSource {
    context: any

    constructor() {
        super()
    }

    initialize(config) {
        this.context = config.context
    }

    async createJournalEntry(journalEntryInput: CreateJournalEntryInput): Promise<JournalEntry> {
        try {
            return sequelize.transaction(async (t) => {
                return JournalEntry.create(journalEntryInput, {
                    include: [
                        {
                            association: JournalEntry.Debits,
                        },
                        {
                            association: JournalEntry.Credits,
                        }
                    ],
                    transaction: t,
                })
            })
        } catch (err) {
            console.log('something broke', err)
        }
    }

    async getJournalEntryById(id: string): Promise<JournalEntry> {
        return JournalEntry.findByPk(idToBuffer(id))
    }
}