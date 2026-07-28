import { z } from 'zod';

import { ACCOUNT_TYPES, NORMAL_BALANCES } from '../accounts/accounts';
import { calendarDateSchema, minorUnitsSchema } from '../wire/wire';

/** Local enums for the preview drafts — the account schema's own copies are module-private. */
const accountTypeSchema = z.enum(ACCOUNT_TYPES);
const normalBalanceSchema = z.enum(NORMAL_BALANCES);

/**
 * The QuickBooks CSV migration import (Phase 3 — the launch gate).
 *
 * ## What it is, and what it deliberately is not
 *
 * A one-time cutover: a chart of accounts, the customers and vendors, and an **opening
 * trial balance** posted as a single opening journal. It brings a business onto OpenBooks
 * without re-keying, which is the minimum credible launch bar — not a full transaction
 * replay. History stays in QuickBooks; the balances come across (D-33 reserved
 * `external_refs` for the bulk sync that is a different, later thing).
 *
 * ## Why the files are text in the body, and the import is synchronous
 *
 * A QuickBooks export is CSV, which is text — so the files ride in the JSON body as
 * strings, exactly as the bank statement import does (`banking/imports.ts`): one content
 * type, no multipart, and an MCP tool (M5) can send the same request. Unlike a bank
 * import there is no queue: applying a chart is already a synchronous loop over
 * `createAccount` in one transaction (`chart-templates.service.ts`), and the whole cutover
 * is that plus contacts plus one journal — small, bounded, and atomic, so it commits in a
 * single request rather than a worker poll.
 *
 * ## Preview, then commit
 *
 * `preview` writes nothing and answers "what would this do, and what is wrong with it" —
 * how many accounts and contacts, whether the trial balance balances, which lines name an
 * account the accounts file does not. `import` does it, all-or-nothing, in one transaction.
 * The pair mirrors the bank import's `previewImport`/`startImport`.
 */

/** 4 MiB, matching the bank statement limit — a QuickBooks list export is far smaller. */
export const QUICKBOOKS_CSV_MAX_LENGTH = 4_194_304;

/**
 * One CSV file's contents, as text. The importer expects a header row; the columns each
 * file carries are documented on the request fields below.
 */
const csvContentSchema = z.string().trim().min(1).max(QUICKBOOKS_CSV_MAX_LENGTH);

/**
 * The request — one date and up to four CSV files.
 *
 * `accounts` is the only required file: a chart is the thing everything else references,
 * and a contact or a trial-balance line naming an account that was never created is the
 * error the preview exists to catch. `trialBalance` is optional because a business may
 * want its lists carried over with balances entered by hand; when present it must balance,
 * and it is posted as the opening journal dated `asOfDate`.
 */
export const quickbooksImportRequestSchema = z
  .strictObject({
    asOfDate: calendarDateSchema.meta({
      description:
        'The date the opening balances are stated as at — the opening journal’s entry date. It ' +
        'must fall inside a generated, open fiscal period, so the year is generated first if it ' +
        'has not been. Ignored when no trial balance is sent.',
    }),
    accounts: csvContentSchema.meta({
      description:
        'The chart of accounts CSV. Header row with columns Name (required), Type (required — a ' +
        'QuickBooks account type, mapped to one of the five account types), Number (the account ' +
        'code, optional) and Description (optional). Parents need not precede children.',
    }),
    customers: csvContentSchema.nullish().meta({
      description:
        'The customer list CSV. Header row with Name (required), Number, Email and Phone ' +
        '(all optional). Each becomes a contact with `isCustomer`.',
    }),
    vendors: csvContentSchema.nullish().meta({
      description:
        'The vendor list CSV. Same columns as customers. Each becomes a contact with `isVendor` ' +
        '— a name present in both lists is one contact carrying both flags.',
    }),
    trialBalance: csvContentSchema.nullish().meta({
      description:
        'The trial balance CSV. Header row with Account (matching an account Number, or its Name ' +
        'when no number is given), Debit and Credit (decimal amounts, exactly one non-empty per ' +
        'row). Posted whole as the opening journal, so its debits and credits must be equal.',
    }),
  })
  .meta({
    id: 'QuickBooksImportRequest',
    description:
      'A QuickBooks CSV cutover: a chart of accounts, optional customer and vendor lists, and an ' +
      'optional opening trial balance. Sent to `preview` (writes nothing) or `import` (commits).',
  });

export type QuickBooksImportRequest = z.infer<typeof quickbooksImportRequestSchema>;

/**
 * One thing wrong with one row, surfaced by the preview rather than discovered at commit.
 * `file` and `row` locate it (1-based row, excluding the header); `message` is the reason.
 */
export const quickbooksImportIssueSchema = z.object({
  file: z.enum(['accounts', 'customers', 'vendors', 'trialBalance']),
  row: z.number().int().positive(),
  message: z.string(),
});

export type QuickBooksImportIssue = z.infer<typeof quickbooksImportIssueSchema>;

/** An account the import would create, as the preview shows it (after type mapping). */
export const quickbooksAccountDraftSchema = z.object({
  code: z.string(),
  name: z.string(),
  type: accountTypeSchema,
  normalBalance: normalBalanceSchema,
});

export type QuickBooksAccountDraft = z.infer<typeof quickbooksAccountDraftSchema>;

/** A contact the import would create, as the preview shows it. */
export const quickbooksContactDraftSchema = z.object({
  displayName: z.string(),
  code: z.string().nullable(),
  email: z.string().nullable(),
  isCustomer: z.boolean(),
  isVendor: z.boolean(),
});

export type QuickBooksContactDraft = z.infer<typeof quickbooksContactDraftSchema>;

/**
 * The opening balance's own summary. `balanced` is `totalDebits === totalCredits`; a
 * commit refuses an unbalanced trial balance, so the preview surfaces it first.
 * `unmatchedAccounts` names any trial-balance line whose account is not in the chart —
 * the other thing that would fail the commit.
 */
export const quickbooksOpeningBalancePreviewSchema = z.object({
  balanced: z.boolean(),
  totalDebits: minorUnitsSchema,
  totalCredits: minorUnitsSchema,
  lineCount: z.number().int().nonnegative(),
  unmatchedAccounts: z.array(z.string()),
});

export type QuickBooksOpeningBalancePreview = z.infer<typeof quickbooksOpeningBalancePreviewSchema>;

/**
 * The preview: what the commit would create, and everything wrong with the input. It
 * writes nothing. `accounts.conflicts` and `contacts.conflicts` list codes already in use
 * (the commit is all-or-nothing, so any conflict fails it).
 */
export const quickbooksImportPreviewSchema = z
  .strictObject({
    accounts: z.object({
      toCreate: z.number().int().nonnegative(),
      drafts: z.array(quickbooksAccountDraftSchema),
      conflicts: z.array(z.string()),
    }),
    contacts: z.object({
      customers: z.number().int().nonnegative(),
      vendors: z.number().int().nonnegative(),
      drafts: z.array(quickbooksContactDraftSchema),
      conflicts: z.array(z.string()),
    }),
    openingBalance: quickbooksOpeningBalancePreviewSchema.nullable(),
    issues: z.array(quickbooksImportIssueSchema),
  })
  .meta({
    id: 'QuickBooksImportPreview',
    description:
      'A dry run of a QuickBooks import: the accounts and contacts it would create, the opening ' +
      'balance summary, and every row-level problem — nothing is written.',
  });

export type QuickBooksImportPreview = z.infer<typeof quickbooksImportPreviewSchema>;

/**
 * The result of a committed import. `openingJournalId` is null when no trial balance was
 * sent (lists only).
 */
export const quickbooksImportResultSchema = z
  .strictObject({
    accountsCreated: z.number().int().nonnegative(),
    customersCreated: z.number().int().nonnegative(),
    vendorsCreated: z.number().int().nonnegative(),
    openingJournalId: z.uuid().nullable(),
  })
  .meta({
    id: 'QuickBooksImportResult',
    description: 'What a committed QuickBooks import created.',
  });

export type QuickBooksImportResult = z.infer<typeof quickbooksImportResultSchema>;
