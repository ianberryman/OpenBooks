import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
import { noJournalWrites } from '../src/rules/no-journal-writes.js';

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

const ALLOW = [{ allow: ['src/modules/ledger/posting.repository.ts'] }];

describe('no-journal-writes', () => {
  it('confines journal writes to the posting repository', () => {
    ruleTester.run('no-journal-writes', noJournalWrites, {
      valid: [
        // The posting repository is the one permitted writer.
        {
          code: "await db.insertInto('journals').values(row).execute();",
          options: ALLOW,
          filename: '/repo/packages/server/src/modules/ledger/posting.repository.ts',
        },
        // Reads are unrestricted — the trial balance aggregates journal_lines.
        {
          code: "await db.selectFrom('journal_lines').selectAll().execute();",
          options: ALLOW,
          filename: '/repo/packages/server/src/modules/reports/trial-balance.service.ts',
        },
        // Writes to other tables are none of this rule's business.
        {
          code: "await db.insertInto('accounts').values(row).execute();",
          options: ALLOW,
          filename: '/repo/packages/server/src/modules/accounts/accounts.service.ts',
        },
      ],
      invalid: [
        {
          code: "await db.insertInto('journals').values(row).execute();",
          options: ALLOW,
          filename: '/repo/packages/server/src/modules/invoices/invoices.service.ts',
          errors: [{ messageId: 'noJournalWrite' }],
        },
        {
          code: "await db.updateTable('journals').set({ memo: 'x' }).execute();",
          options: ALLOW,
          filename: '/repo/packages/server/src/modules/invoices/invoices.service.ts',
          errors: [{ messageId: 'noJournalWrite' }],
        },
        {
          code: "await db.deleteFrom('journal_lines').execute();",
          options: ALLOW,
          filename: '/repo/packages/server/src/modules/invoices/invoices.service.ts',
          errors: [{ messageId: 'noJournalWrite' }],
        },
      ],
    });
  });
});
