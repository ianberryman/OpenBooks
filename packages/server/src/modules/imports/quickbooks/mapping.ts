import type { AccountType, NormalBalance } from '@openbooks/shared-types';
import { ACCOUNT_TYPES } from '@openbooks/shared-types';

/**
 * QuickBooks account type → OpenBooks `(type, normalBalance)` (Phase 3, the
 * QuickBooks CSV migration importer).
 *
 * A QuickBooks export names an account's type (`Bank`, `Accounts Receivable`, …)
 * and carries no column for which side increases it — QuickBooks derives that
 * internally from the type's statement section and never writes it out. So this
 * table states OpenBooks' own `normalBalance` for each QuickBooks type rather than
 * reading one from the file: every asset and expense type is `debit` and every
 * liability, equity, revenue type is `credit`, which is the ordinary rule
 * `0002_ledger` assumes and the one every stock QuickBooks chart follows. A chart
 * with a genuine contra account (accumulated depreciation, say) exports as `Fixed
 * Asset` with no way to say "credit" from the file, and lands here with the type's
 * ordinary balance; correcting a contra account's balance after import is an
 * `updateAccount` the same as it would be for a hand-typed chart.
 */
export interface AccountTypeMapping {
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
}

/** Case-insensitive, trimmed: `mapQuickBooksAccountType` normalizes before this lookup. */
const QUICKBOOKS_TYPE_MAP: ReadonlyMap<string, AccountTypeMapping> = new Map([
  // Asset, normal balance debit.
  ['bank', { type: 'asset', normalBalance: 'debit' }],
  ['accounts receivable', { type: 'asset', normalBalance: 'debit' }],
  ['other current asset', { type: 'asset', normalBalance: 'debit' }],
  ['fixed asset', { type: 'asset', normalBalance: 'debit' }],
  ['other asset', { type: 'asset', normalBalance: 'debit' }],
  ['inventory', { type: 'asset', normalBalance: 'debit' }],
  // Liability, normal balance credit.
  ['accounts payable', { type: 'liability', normalBalance: 'credit' }],
  ['credit card', { type: 'liability', normalBalance: 'credit' }],
  ['other current liability', { type: 'liability', normalBalance: 'credit' }],
  ['long term liability', { type: 'liability', normalBalance: 'credit' }],
  ['other liability', { type: 'liability', normalBalance: 'credit' }],
  // Equity, normal balance credit.
  ['equity', { type: 'equity', normalBalance: 'credit' }],
  // Revenue, normal balance credit.
  ['income', { type: 'revenue', normalBalance: 'credit' }],
  ['other income', { type: 'revenue', normalBalance: 'credit' }],
  // Expense, normal balance debit.
  ['cost of goods sold', { type: 'expense', normalBalance: 'debit' }],
  ['expense', { type: 'expense', normalBalance: 'debit' }],
  ['other expense', { type: 'expense', normalBalance: 'debit' }],
]);

/** The one QuickBooks type this importer treats as the receivable control account. */
export const QUICKBOOKS_RECEIVABLE_TYPE = 'Accounts Receivable';
/** The one QuickBooks type this importer treats as the payable control account. */
export const QUICKBOOKS_PAYABLE_TYPE = 'Accounts Payable';

const DOMAIN_TYPES: ReadonlySet<string> = new Set(ACCOUNT_TYPES);

/** `raw`, trimmed and lower-cased — the form every comparison in this file uses. */
function normalize(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Maps one QuickBooks (or already-OpenBooks) account type string, or `null` when
 * it names neither — the caller turns that into a row issue rather than a thrown
 * error, since one bad row must not fail the whole file (`parse.ts`).
 *
 * Also accepts the five domain type names directly (`asset`, `liability`,
 * `equity`, `revenue`, `expense`), for a file already exported in OpenBooks'
 * own vocabulary rather than QuickBooks'. `normalBalance` for those is derived
 * by the same debit/credit split as the QuickBooks table: `asset`/`expense` are
 * `debit`, everything else is `credit`.
 */
export function mapQuickBooksAccountType(raw: string): AccountTypeMapping | null {
  const normalized = normalize(raw);
  if (normalized.length === 0) return null;

  const mapped = QUICKBOOKS_TYPE_MAP.get(normalized);
  if (mapped !== undefined) return mapped;

  if (DOMAIN_TYPES.has(normalized)) {
    const type = normalized as AccountType;
    return { type, normalBalance: type === 'asset' || type === 'expense' ? 'debit' : 'credit' };
  }

  return null;
}

/** Whether `raw` names QuickBooks' `Accounts Receivable` type, for control-account nomination. */
export function isQuickBooksReceivableType(raw: string): boolean {
  return normalize(raw) === normalize(QUICKBOOKS_RECEIVABLE_TYPE);
}

/** Whether `raw` names QuickBooks' `Accounts Payable` type, for control-account nomination. */
export function isQuickBooksPayableType(raw: string): boolean {
  return normalize(raw) === normalize(QUICKBOOKS_PAYABLE_TYPE);
}
