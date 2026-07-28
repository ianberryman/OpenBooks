import { ACCOUNT_CODE_MAX_LENGTH } from '@openbooks/shared-types';
import type { AccountType, NormalBalance, QuickBooksImportIssue } from '@openbooks/shared-types';
import type { Money } from '@openbooks/shared-types/money';
import { MoneyParseError, fromDecimalString } from '@openbooks/shared-types/money';

import { tokenizeCsv, type CsvRecord } from '../../banking/csv/tokenize';

import { mapQuickBooksAccountType } from './mapping';

/**
 * Pure CSV parsers for the QuickBooks migration import (Phase 3).
 *
 * Strings in, data and issues out — no database, no request context (the file
 * header docstring on `service.ts` explains why the split matters: these are unit
 * tested directly, with no testcontainers). Header rows are matched by name,
 * case-insensitively, rather than by position — the position-based
 * `banking/csv/parse.ts` reads a *mapped* column set the user configured once;
 * this reads whatever header QuickBooks itself printed, which is fixed by their
 * export and never configured by a caller.
 *
 * Every row this file cannot use becomes one `QuickBooksImportIssue` (1-based,
 * excluding the header) rather than a thrown error — a bad row must not fail the
 * whole file, which is what lets the preview show a caller every problem at once
 * instead of one at a time across repeated uploads.
 */

/** One accounts-CSV row, successfully read. */
export interface ParsedAccountRow {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  /**
   * The raw QuickBooks type string this row named, trimmed — not part of the wire
   * draft (`quickbooksAccountDraftSchema` has no such field). Kept only so
   * `service.ts` can find the account whose QuickBooks type was `Accounts
   * Receivable` / `Accounts Payable` for control-account nomination, without
   * re-deriving it from `type`/`normalBalance`, which many QuickBooks types share.
   */
  readonly qbType: string;
}

export interface ParsedAccounts {
  readonly accounts: readonly ParsedAccountRow[];
  readonly issues: readonly QuickBooksImportIssue[];
}

/** One customers/vendors-CSV row, merged by name — see `parseContactsCsv`. */
export interface ParsedContactRow {
  readonly displayName: string;
  readonly code: string | null;
  readonly email: string | null;
  readonly isCustomer: boolean;
  readonly isVendor: boolean;
}

export interface ParsedContacts {
  readonly contacts: readonly ParsedContactRow[];
  readonly issues: readonly QuickBooksImportIssue[];
}

/**
 * One trial-balance-CSV row, successfully read. `accountRef` is unresolved —
 * `service.ts` matches it against an account's code or name.
 */
export interface ParsedTrialBalanceRow {
  readonly accountRef: string;
  readonly side: 'debit' | 'credit';
  readonly amount: Money;
}

export interface ParsedTrialBalance {
  readonly rows: readonly ParsedTrialBalanceRow[];
  readonly issues: readonly QuickBooksImportIssue[];
}

const DELIMITER = ',';

/**
 * Parses the chart-of-accounts CSV: `Name` (required), `Type` (required, mapped
 * through `mapping.ts`), `Number` (optional — becomes `code`; synthesized when
 * blank), `Description` (optional, ignored — Phase 3 has nowhere to put it yet).
 *
 * A blank `Number` gets a deterministic, unique code derived from `Name`: an
 * upper-cased slug, truncated to fit `ACCOUNT_CODE_MAX_LENGTH`, and suffixed
 * `-2`, `-3`, … on a collision either with another synthesized code or with an
 * explicit `Number` earlier in the same file. Deterministic so re-running the
 * same file (a corrected retry, or preview-then-commit) proposes the same codes.
 */
export function parseAccountsCsv(csv: string): ParsedAccounts {
  const records = tokenizeCsv(csv, DELIMITER);
  if (records.length === 0) return { accounts: [], issues: [] };

  const header = indexHeader(records[0]?.fields ?? []);
  const nameIdx = header.get('name');
  const typeIdx = header.get('type');
  const numberIdx = header.get('number');

  const issues: QuickBooksImportIssue[] = [];
  const accounts: ParsedAccountRow[] = [];
  const usedCodes = new Set<string>();

  records.slice(1).forEach((record, index) => {
    const row = index + 1;

    const name = nameIdx === undefined ? '' : cell(record, nameIdx);
    if (name.length === 0) {
      issues.push({ file: 'accounts', row, message: 'Missing required column "Name".' });
      return;
    }

    const rawType = typeIdx === undefined ? '' : cell(record, typeIdx);
    const mapped = mapQuickBooksAccountType(rawType);
    if (mapped === null) {
      issues.push({
        file: 'accounts',
        row,
        message:
          `Unmapped account type ${JSON.stringify(rawType)} for account ` +
          `${JSON.stringify(name)}.`,
      });
      return;
    }

    const explicitCode = numberIdx === undefined ? '' : cell(record, numberIdx);
    const code = explicitCode.length > 0 ? explicitCode : synthesizeCode(name, usedCodes);
    usedCodes.add(code.toLowerCase());

    accounts.push({
      code,
      name,
      type: mapped.type,
      normalBalance: mapped.normalBalance,
      qbType: rawType,
    });
  });

  return { accounts, issues };
}

/**
 * Parses the customers and vendors CSVs into one contact list, merging a name
 * that appears in both onto one row carrying both flags — case-insensitive, so
 * `"Acme Co"` in customers and `"ACME CO"` in vendors are the same contact.
 *
 * Either file may be absent (`null`), matching the wire contract: a caller may
 * carry over only the chart, or only one side of the ledger's relationships.
 */
export function parseContactsCsv(
  customersCsv: string | null,
  vendorsCsv: string | null,
): ParsedContacts {
  const issues: QuickBooksImportIssue[] = [];
  const byName = new Map<string, ParsedContactRow>();

  const parseOne = (
    csv: string | null,
    file: 'customers' | 'vendors',
    isCustomer: boolean,
    isVendor: boolean,
  ): void => {
    if (csv === null) return;
    const records = tokenizeCsv(csv, DELIMITER);
    if (records.length === 0) return;

    const header = indexHeader(records[0]?.fields ?? []);
    const nameIdx = header.get('name');
    const codeIdx = header.get('number') ?? header.get('code');
    const emailIdx = header.get('email');

    records.slice(1).forEach((record, index) => {
      const row = index + 1;

      const name = nameIdx === undefined ? '' : cell(record, nameIdx);
      if (name.length === 0) {
        issues.push({ file, row, message: 'Missing required column "Name".' });
        return;
      }

      const code = codeIdx === undefined ? '' : cell(record, codeIdx);
      const email = emailIdx === undefined ? '' : cell(record, emailIdx);
      const key = name.toLowerCase();
      const existing = byName.get(key);

      byName.set(key, {
        displayName: existing?.displayName ?? name,
        code: existing?.code ?? (code.length > 0 ? code : null),
        email: existing?.email ?? (email.length > 0 ? email : null),
        isCustomer: (existing?.isCustomer ?? false) || isCustomer,
        isVendor: (existing?.isVendor ?? false) || isVendor,
      });
    });
  };

  parseOne(customersCsv, 'customers', true, false);
  parseOne(vendorsCsv, 'vendors', false, true);

  return { contacts: [...byName.values()], issues };
}

/**
 * Parses the trial-balance CSV: `Account` (required — matched against a parsed
 * account's code or name by `service.ts`, not here), `Debit`/`Credit` (decimal
 * strings, exactly one non-empty per row).
 */
export function parseTrialBalanceCsv(csv: string): ParsedTrialBalance {
  const records = tokenizeCsv(csv, DELIMITER);
  if (records.length === 0) return { rows: [], issues: [] };

  const header = indexHeader(records[0]?.fields ?? []);
  const accountIdx = header.get('account');
  const debitIdx = header.get('debit');
  const creditIdx = header.get('credit');

  const issues: QuickBooksImportIssue[] = [];
  const rows: ParsedTrialBalanceRow[] = [];

  records.slice(1).forEach((record, index) => {
    const row = index + 1;

    const accountRef = accountIdx === undefined ? '' : cell(record, accountIdx);
    if (accountRef.length === 0) {
      issues.push({ file: 'trialBalance', row, message: 'Missing required column "Account".' });
      return;
    }

    const debitRaw = debitIdx === undefined ? '' : cell(record, debitIdx);
    const creditRaw = creditIdx === undefined ? '' : cell(record, creditIdx);
    const hasDebit = debitRaw.length > 0;
    const hasCredit = creditRaw.length > 0;

    if (hasDebit === hasCredit) {
      issues.push({
        file: 'trialBalance',
        row,
        message: hasDebit
          ? 'Both "Debit" and "Credit" are filled in; exactly one is expected per row.'
          : 'Neither "Debit" nor "Credit" is filled in; exactly one is expected per row.',
      });
      return;
    }

    const side: 'debit' | 'credit' = hasDebit ? 'debit' : 'credit';
    const raw = hasDebit ? debitRaw : creditRaw;

    let amount: Money;
    try {
      amount = fromDecimalString(raw);
    } catch (error) {
      if (!(error instanceof MoneyParseError)) throw error;
      issues.push({
        file: 'trialBalance',
        row,
        message: `${JSON.stringify(raw)} is not a valid decimal amount.`,
      });
      return;
    }

    rows.push({ accountRef, side, amount });
  });

  return { rows, issues };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Header name (trimmed, lower-cased) to its column index. First occurrence wins. */
function indexHeader(headerFields: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  headerFields.forEach((field, index) => {
    const key = field.trim().toLowerCase();
    if (key.length > 0 && !map.has(key)) map.set(key, index);
  });
  return map;
}

/** A cell's trimmed value, or `''` for a column past the end of a short row. */
function cell(record: CsvRecord, index: number): string {
  return (record.fields[index] ?? '').trim();
}

/**
 * An upper-cased, punctuation-collapsed slug of `name`, unique against `used` —
 * `-2`, `-3`, … on a collision, never `-1`, so the unsuffixed form is always the
 * first attempt.
 */
function synthesizeCode(name: string, used: ReadonlySet<string>): string {
  const base = slugify(name);

  let candidate = truncate(base, ACCOUNT_CODE_MAX_LENGTH);
  let suffix = 1;
  while (used.has(candidate.toLowerCase())) {
    suffix += 1;
    const suffixText = `-${String(suffix)}`;
    candidate = `${truncate(base, ACCOUNT_CODE_MAX_LENGTH - suffixText.length)}${suffixText}`;
  }
  return candidate;
}

function slugify(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length === 0 ? 'ACCOUNT' : cleaned;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}
