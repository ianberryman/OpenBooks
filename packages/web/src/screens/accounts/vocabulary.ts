import type { AccountType, NormalBalance } from './accounts-api';

/**
 * The words this screen puts on the wire values, and the one piece of accounting judgement
 * it is allowed to make.
 *
 * Both label tables are `Record`s over the generated unions rather than arrays of pairs,
 * so a type or a balance added on the server fails to compile here instead of rendering as
 * a raw wire token. Same construction, and the same reason, as `PRESENTATION` in
 * `src/api/presentation.ts`.
 */
export const ACCOUNT_TYPE_LABELS: Readonly<Record<AccountType, string>> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
};

export const NORMAL_BALANCE_LABELS: Readonly<Record<NormalBalance, string>> = {
  debit: 'Debit',
  credit: 'Credit',
};

/** Statement order, which is the order an accountant reads a chart in. */
export const ACCOUNT_TYPES: readonly AccountType[] = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
];

export const NORMAL_BALANCES: readonly NormalBalance[] = ['debit', 'credit'];

export function isAccountType(value: string): value is AccountType {
  return Object.hasOwn(ACCOUNT_TYPE_LABELS, value);
}

export function isNormalBalance(value: string): value is NormalBalance {
  return Object.hasOwn(NORMAL_BALANCE_LABELS, value);
}

/**
 * The side that increases most accounts of a type — and this table is **not** a default.
 *
 * `normalBalance` is stored and never derived (`createAccountRequestSchema`): contra
 * accounts are real, and accumulated depreciation is an `asset` whose normal balance is
 * `credit`. Defaulting from `type` would be right most of the time and silently wrong
 * exactly where the field matters, because a contra account created on the wrong side is
 * not visibly broken — it reports with an inverted sign, which reads as a data problem
 * rather than a setup problem.
 *
 * So this is used for one thing: recognising the contra case *after* the user has chosen
 * both, in order to say "this is a contra account, which is a real thing" in neutral
 * prose. A user who means it gets confirmation instead of a warning, and a user who
 * mis-clicked gets the one sentence that tells them.
 */
const CONVENTIONAL_BALANCE: Readonly<Record<AccountType, NormalBalance>> = {
  asset: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
  expense: 'debit',
};

export function isContra(type: AccountType, normalBalance: NormalBalance): boolean {
  return CONVENTIONAL_BALANCE[type] !== normalBalance;
}

export function contraNote(type: AccountType, normalBalance: NormalBalance): string {
  return (
    `A ${ACCOUNT_TYPE_LABELS[type].toLowerCase()} account whose normal balance is ` +
    `${NORMAL_BALANCE_LABELS[normalBalance].toLowerCase()} is a contra account — accumulated ` +
    'depreciation and an allowance for doubtful accounts are both of this shape. That is a ' +
    'valid setup, not a mistake; the two fields are independent and nothing derives one from ' +
    'the other.'
  );
}
