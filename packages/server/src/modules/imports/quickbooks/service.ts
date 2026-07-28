import type { JournalLineInput } from '@openbooks/plugin-api';
import type {
  Account,
  QuickBooksAccountDraft,
  QuickBooksImportIssue,
  QuickBooksImportPreview,
  QuickBooksImportRequest,
  QuickBooksImportResult,
  QuickBooksOpeningBalancePreview,
} from '@openbooks/shared-types';
import { quickbooksImportRequestSchema } from '@openbooks/shared-types';
import { equals, sum, toMinorString, toMinorUnits } from '@openbooks/shared-types/money';

import type { RequestContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { orgScope as toOrgId, tenantDb, uuidToBuffer } from '../../../db';
import {
  ConflictError,
  InternalError,
  PreconditionFailedError,
  ValidationError,
  parseInput,
} from '../../../errors';
import { createAccount } from '../../accounts';
import {
  selectExistingCodes as selectExistingAccountCodes,
} from '../../accounts/accounts.repository';
import { createContact } from '../../contacts';
import {
  selectExistingCodes as selectExistingContactCodes,
} from '../../contacts/contacts.repository';
import { postJournal } from '../../ledger';
import { generateFiscalYear, selectFiscalYearStartMonth } from '../../periods';
import { requirePermission } from '../../permissions';
import { nominateControlAccountsIfUnset } from '../../settings';

import { isQuickBooksPayableType, isQuickBooksReceivableType } from './mapping';
import type { ParsedAccountRow, ParsedContactRow, ParsedTrialBalanceRow } from './parse';
import { parseAccountsCsv, parseContactsCsv, parseTrialBalanceCsv } from './parse';

/**
 * The QuickBooks CSV migration importer (Phase 3, the launch gate).
 *
 * Read `@openbooks/shared-types/imports/quickbooks` first — it is the pinned wire
 * contract and carries the "what this is and is not" argument. This file is the
 * two operations that contract describes: `previewQuickBooksImport` (writes
 * nothing) and `importQuickBooks` (one all-or-nothing transaction).
 *
 * ## The shape this borrows from `chart-templates.service.ts`
 *
 * `importQuickBooks` writes through `createAccount` and `createContact` in a
 * loop, one row at a time, inside one `orgScope(ctx).transaction` — never a bulk
 * insert. That is the same trade `applyChartTemplate` makes and for the same
 * reason: it is the only way a QuickBooks row is validated by exactly the code
 * that validates a hand-typed one, with no second write path to bypass the
 * hierarchy rules, the code-uniqueness conflict, or the shared zod schema. It
 * costs a few hundred statements on one connection for a chart this size, once,
 * at onboarding — not a hot path.
 *
 * ## Why the opening journal is a separate step, not folded into the same loop
 *
 * Every account has to exist — with its real id — before a journal line can name
 * one, and the accounts and contacts are independent of each other and of the
 * trial balance. So the order inside the transaction is: accounts, then control
 * accounts (which need the accounts' ids), then contacts, then — only if a trial
 * balance was sent — the fiscal year and the opening journal, which need every
 * account's real id and nothing else.
 */

// ---------------------------------------------------------------------------
// Preview — synchronous, writes nothing
// ---------------------------------------------------------------------------

export async function previewQuickBooksImport(
  input: QuickBooksImportRequest,
  ctx: RequestContext,
): Promise<QuickBooksImportPreview> {
  await requirePermission(ctx, 'accounts.read');
  await requirePermission(ctx, 'contacts.read');
  const request = parseInput(quickbooksImportRequestSchema, input);

  const parsedAccounts = parseAccountsCsv(request.accounts);
  const parsedContacts = parseContactsCsv(request.customers ?? null, request.vendors ?? null);
  const parsedTrialBalance = isPresent(request.trialBalance)
    ? parseTrialBalanceCsv(request.trialBalance)
    : null;

  const issues = [
    ...parsedAccounts.issues,
    ...parsedContacts.issues,
    ...(parsedTrialBalance?.issues ?? []),
  ];

  const db = scopedDb(ctx);
  const accountConflicts = await selectExistingAccountCodes(
    db,
    parsedAccounts.accounts.map((account) => account.code),
  );
  const contactConflicts = await selectExistingContactCodes(
    db,
    parsedContacts.contacts.flatMap((contact) => (contact.code === null ? [] : [contact.code])),
  );

  return {
    accounts: {
      toCreate: parsedAccounts.accounts.length,
      drafts: parsedAccounts.accounts.map(toAccountDraft),
      conflicts: [...accountConflicts],
    },
    contacts: {
      customers: parsedContacts.contacts.filter((contact) => contact.isCustomer).length,
      vendors: parsedContacts.contacts.filter((contact) => contact.isVendor).length,
      drafts: [...parsedContacts.contacts],
      conflicts: [...contactConflicts],
    },
    openingBalance:
      parsedTrialBalance === null
        ? null
        : buildOpeningBalancePreview(parsedTrialBalance.rows, parsedAccounts.accounts),
    issues,
  };
}

// ---------------------------------------------------------------------------
// Import — one all-or-nothing transaction
// ---------------------------------------------------------------------------

export async function importQuickBooks(
  input: QuickBooksImportRequest,
  ctx: RequestContext,
): Promise<QuickBooksImportResult> {
  await requirePermission(ctx, 'accounts.write');
  await requirePermission(ctx, 'contacts.write');
  await requirePermission(ctx, 'journals.post');
  const request = parseInput(quickbooksImportRequestSchema, input);

  const parsedAccounts = parseAccountsCsv(request.accounts);
  const parsedContacts = parseContactsCsv(request.customers ?? null, request.vendors ?? null);
  const parsedTrialBalance = isPresent(request.trialBalance)
    ? parseTrialBalanceCsv(request.trialBalance)
    : null;

  const issues = [
    ...parsedAccounts.issues,
    ...parsedContacts.issues,
    ...(parsedTrialBalance?.issues ?? []),
  ];
  if (issues.length > 0) throw rowIssuesError(issues);

  // Balance and reference checks happen before anything is written — an
  // unbalanced or unmatched trial balance is refused without a single account or
  // contact landing, exactly as a code collision below is.
  if (parsedTrialBalance !== null) {
    const opening = buildOpeningBalancePreview(parsedTrialBalance.rows, parsedAccounts.accounts);
    if (opening.unmatchedAccounts.length > 0) throw unknownAccountError(opening.unmatchedAccounts);
    if (!opening.balanced) throw unbalancedError(opening.totalDebits, opening.totalCredits);
  }

  return scopedDb(ctx).transaction(async (trx) => {
    await refuseAccountCodeCollisions(trx, parsedAccounts.accounts);
    await refuseContactCodeCollisions(trx, parsedContacts.contacts);

    const createdAccounts: Account[] = [];
    let receivableId: Buffer | null = null;
    let payableId: Buffer | null = null;

    for (const draft of parsedAccounts.accounts) {
      const account = await createAccount(
        {
          code: draft.code,
          name: draft.name,
          type: draft.type,
          normalBalance: draft.normalBalance,
        },
        ctx,
      );
      createdAccounts.push(account);

      if (receivableId === null && isQuickBooksReceivableType(draft.qbType)) {
        receivableId = uuidToBuffer(account.id);
      }
      if (payableId === null && isQuickBooksPayableType(draft.qbType)) {
        payableId = uuidToBuffer(account.id);
      }
    }

    await nominateControlAccountsIfUnset(trx, {
      ...(receivableId === null ? {} : { receivable: receivableId }),
      ...(payableId === null ? {} : { payable: payableId }),
    });

    let customersCreated = 0;
    let vendorsCreated = 0;
    for (const contact of parsedContacts.contacts) {
      await createContact(
        {
          displayName: contact.displayName,
          code: contact.code,
          email: contact.email,
          isCustomer: contact.isCustomer,
          isVendor: contact.isVendor,
        },
        ctx,
      );
      if (contact.isCustomer) customersCreated += 1;
      if (contact.isVendor) vendorsCreated += 1;
    }

    let openingJournalId: string | null = null;
    if (parsedTrialBalance !== null) {
      const lines = toJournalLines(parsedTrialBalance.rows, createdAccounts);
      openingJournalId = await postOpeningJournal(ctx, request.asOfDate, lines);
    }

    return {
      accountsCreated: createdAccounts.length,
      customersCreated,
      vendorsCreated,
      openingJournalId,
    };
  });
}

// ---------------------------------------------------------------------------
// Opening journal — ensure the fiscal year, then post
// ---------------------------------------------------------------------------

/**
 * Posts the opening journal, generating the fiscal year first if `postJournal`
 * reports one is missing.
 *
 * The generate-first alternative — always calling `generateFiscalYear` before
 * posting — was rejected: an org whose year already exists would meet
 * `generateFiscalYear`'s own overlap `ConflictError` on every import, for a year
 * it never needed to generate. Catching `period_missing` means generation runs
 * only when the post actually needs it, which is also the one case where
 * `periods.write` — a permission this operation does not otherwise require —
 * has to be held by the caller; D-17 forbids posting from creating a period as a
 * side effect silently, and this is the deliberate, narrow exception that name
 * asks for instead.
 */
async function postOpeningJournal(
  ctx: RequestContext,
  asOfDate: string,
  lines: readonly JournalLineInput[],
): Promise<string> {
  const journalInput = {
    date: asOfDate,
    memo: 'Opening balances (QuickBooks import)',
    source: 'opening',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    lines,
  };

  try {
    const posted = await postJournal(journalInput, ctx);
    return posted.journalId;
  } catch (error) {
    const missingPeriod =
      error instanceof PreconditionFailedError && error.details?.precondition === 'period_missing';
    if (!missingPeriod) throw error;

    await ensureFiscalYearCovers(ctx, asOfDate);
    const posted = await postJournal(journalInput, ctx);
    return posted.journalId;
  }
}

async function ensureFiscalYearCovers(ctx: RequestContext, date: string): Promise<void> {
  const startMonth = await selectFiscalYearStartMonth(toOrgId(ctx.orgId));
  if (startMonth === undefined) {
    throw new InternalError('No org row for the org id in request context.');
  }

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // The fiscal year containing `date`: it starts at `startMonth` in `year` when
  // `date`'s month has already reached `startMonth`, and in `year - 1` otherwise
  // — the same rule `fiscalYearSpan` encodes the other way around.
  const fiscalYear = month >= startMonth ? year : year - 1;

  await generateFiscalYear({ fiscalYear });
}

// ---------------------------------------------------------------------------
// Trial balance — resolution and balance
// ---------------------------------------------------------------------------

function buildOpeningBalancePreview(
  rows: readonly ParsedTrialBalanceRow[],
  accounts: readonly ParsedAccountRow[],
): QuickBooksOpeningBalancePreview {
  const unmatchedAccounts = rows
    .filter((row) => resolveAccountRef(accounts, row.accountRef) === undefined)
    .map((row) => row.accountRef);

  const debits = sum(rows.filter((row) => row.side === 'debit').map((row) => row.amount));
  const credits = sum(rows.filter((row) => row.side === 'credit').map((row) => row.amount));

  return {
    balanced: equals(debits, credits),
    totalDebits: toMinorString(debits),
    totalCredits: toMinorString(credits),
    lineCount: rows.length,
    unmatchedAccounts,
  };
}

/**
 * Turns each trial-balance row into a journal line, against the accounts this
 * import just created — not the parsed drafts, so the line carries the account's
 * real id. Every row is already known to resolve: `importQuickBooks` refuses an
 * unmatched trial balance before this transaction opens, against the same
 * `resolveAccountRef` match over the same codes and names, so a miss here is a
 * defect in that guarantee rather than the caller's mistake.
 */
function toJournalLines(
  rows: readonly ParsedTrialBalanceRow[],
  createdAccounts: readonly Account[],
): readonly JournalLineInput[] {
  return rows.map((row) => {
    const account = resolveAccountRef(createdAccounts, row.accountRef);
    if (account === undefined) {
      throw new InternalError(
        `Trial balance row referencing ${JSON.stringify(row.accountRef)} did not resolve against ` +
          'the accounts just created, though the pre-commit check found a match. The two ' +
          'resolutions have drifted apart.',
      );
    }

    return { accountId: account.id, side: row.side, amount: toMinorUnits(row.amount) };
  });
}

/**
 * Matches a trial-balance row's `Account` cell against a parsed or created
 * account's code first, then its name — case-insensitively, matching the wire
 * contract's stated precedence ("matching an account Number, or its Name when no
 * number is given"). Generic over the two shapes it is called with:
 * `ParsedAccountRow` (pre-commit, against the file) and `Account` (inside the
 * transaction, against what was just created) both carry `code` and `name`.
 */
function resolveAccountRef<T extends { readonly code: string; readonly name: string }>(
  accounts: readonly T[],
  ref: string,
): T | undefined {
  const needle = ref.trim().toLowerCase();
  return (
    accounts.find((account) => account.code.toLowerCase() === needle) ??
    accounts.find((account) => account.name.toLowerCase() === needle)
  );
}

// ---------------------------------------------------------------------------
// Code collisions — the same all-or-nothing pre-check `applyChartTemplate` runs
// ---------------------------------------------------------------------------

async function refuseAccountCodeCollisions(
  db: TenantDatabase,
  accounts: readonly ParsedAccountRow[],
): Promise<void> {
  const taken = await selectExistingAccountCodes(
    db,
    accounts.map((account) => account.code),
  );
  if (taken.length === 0) return;

  const sorted = [...taken].sort();
  throw new ConflictError(
    `This organization already uses ${String(sorted.length)} of the account codes this import ` +
      `would create, so none of it was applied: ${sorted.join(', ')}. Rename or renumber the ` +
      'colliding accounts on either side, or remove them from the file, and import again.',
    { codes: sorted },
  );
}

async function refuseContactCodeCollisions(
  db: TenantDatabase,
  contacts: readonly ParsedContactRow[],
): Promise<void> {
  const codes = contacts.flatMap((contact) => (contact.code === null ? [] : [contact.code]));
  const taken = await selectExistingContactCodes(db, codes);
  if (taken.length === 0) return;

  const sorted = [...taken].sort();
  throw new ConflictError(
    `This organization already uses ${String(sorted.length)} of the contact codes this import ` +
      `would create, so none of it was applied: ${sorted.join(', ')}. Change the colliding codes ` +
      'in the file, or clear them, and import again.',
    { codes: sorted },
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function scopedDb(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * Neither absent (`undefined`) nor explicitly cleared (`null`) — matches
 * `banking/statements/service.ts`.
 */
function isPresent<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function toAccountDraft(account: ParsedAccountRow): QuickBooksAccountDraft {
  return {
    code: account.code,
    name: account.name,
    type: account.type,
    normalBalance: account.normalBalance,
  };
}

function rowIssuesError(issues: readonly QuickBooksImportIssue[]): ValidationError {
  return new ValidationError(
    'The QuickBooks import files could not all be read; nothing was written.',
    issues.map((issue) => ({ path: `${issue.file}.${String(issue.row)}`, message: issue.message })),
  );
}

function unknownAccountError(unmatchedAccounts: readonly string[]): PreconditionFailedError {
  const sorted = [...unmatchedAccounts].sort();
  return new PreconditionFailedError(
    'opening_balance_unknown_account',
    `The trial balance names ${String(sorted.length)} account(s) the chart does not contain: ` +
      `${sorted.join(', ')}. Every trial-balance line must match an account's Number or Name in ` +
      'the accounts file. Add the missing account, or correct the reference, and import again.',
  );
}

function unbalancedError(totalDebits: string, totalCredits: string): PreconditionFailedError {
  return new PreconditionFailedError(
    'opening_balance_unbalanced',
    `The trial balance does not balance: debits total ${totalDebits} and credits total ` +
      `${totalCredits} minor units. An opening journal must balance exactly, like any other.`,
  );
}
