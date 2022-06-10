import { DataSource }  from 'apollo-datasource';
import {newId, query} from './db';
import NotFoundError from '../errors/NotFoundError';
import {CreateJournalEntryInput, JournalEntry} from "../types/JournalEntry/JournalEntry";

export default class JournalEntryApi extends DataSource {
    context: any

    constructor() {
        super();
    }

    initialize(config) {
        this.context = config.context;
    }

    async createJournalEntry(input: JournalEntry): Promise<JournalEntry> {
      const id = newId()
      const { description, effectiveDate } = input
      await query('INSERT INTO journal_entry SET id = unhex(?), ?',
        [
          id,
          {
            description,
            date_effective: effectiveDate
          }
        ])
      return this.getJournalEntryById(id)
    }

    async getJournalEntryById(id: string): Promise<JournalEntry> {
      const results = await query('SELECT hex(id) as id, description, date_effective, date_created FROM journal_entry WHERE id = unhex(?)', [id])

      const journalEntry = results[0]
      if (!journalEntry) throw new NotFoundError('Journal Entry with id: ' + id + ' not found')

      return {
        id: journalEntry.id,
        description: journalEntry.description,
        effectiveDate: journalEntry.date_effective,
        createdDate: journalEntry.date_created,
      }
    }
}