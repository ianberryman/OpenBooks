import type { AccountType, ChartTemplateId, NormalBalance } from '@openbooks/shared-types';

/**
 * The starter charts of accounts that ship with OpenBooks (OB-039, D-23).
 *
 * ## Why this is data in the source tree and not rows in a migration
 *
 * A template is application content: a set of names and codes that will be revised
 * because someone read them and disagreed, not because the schema changed. Seeding
 * it would make every revision an `ALTER`-shaped problem — a migration that has to
 * decide what to do about the orgs that already copied the old version, which is
 * precisely the versioning question D-23 exists in order not to have. Here, revising
 * a template changes what the *next* org gets and nothing else, because an applied
 * chart is a copy with no link back.
 *
 * ## Why one template and not four
 *
 * The registry below is plural because its shape has to be — `ChartTemplateId` is a
 * union, `listChartTemplates` returns an array, and a client picks from it. What it
 * holds is one chart, and that is a decision rather than a placeholder.
 *
 * A second template is a second thing that has to stay right, and "right" here means
 * an accountant agrees with it. The variants that suggest themselves — a service
 * business with no inventory, a retailer with no subcontractors — differ from the
 * chart below by deleting a handful of accounts, and deleting an unposted account is
 * one call with nothing left behind (see `deleteAccount`). Choosing between two
 * charts they cannot see, on the other hand, asks the user to decide something
 * before they know enough to decide it. So: one chart covering the common shape, and
 * pruning as the way to specialize it. A second should arrive because someone's
 * books needed it, not because the type was a union.
 *
 * ## Codes are fixed-width, and that is not aesthetic
 *
 * `accounts.code` is textual and the chart is ordered by it under
 * `utf8mb4_0900_ai_ci` (see `ACCOUNT_KEYSET` in `accounts.repository.ts`), so
 * `'1100'` sorts before `'900'`. Every code here is four digits, which makes lexical
 * order and statement order the same order. A template that mixed widths would teach
 * a chart that reads wrong on the one screen accountants use most.
 *
 * The gaps are the point too. A code is immutable (D-27), so a chart numbered 1000,
 * 1001, 1002 has nowhere to put the second bank account and the only remedy left is
 * a code that sorts in the wrong place forever.
 *
 * ## Contra accounts are the part worth checking
 *
 * Four accounts below carry a `normalBalance` that does not follow from their
 * `type`: accumulated depreciation and the allowance for doubtful accounts are
 * assets with a credit balance, owner draws is equity with a debit balance, and
 * sales returns and allowances is revenue with a debit balance. `0002_ledger`
 * deliberately declines to constrain the two columns against each other so that
 * these are representable, and a starter chart that got them wrong would be worse
 * than no starter chart at all: an inverted contra account is not visibly broken, it
 * reports with the wrong sign and reads as a data problem rather than a setup one.
 */

/**
 * One account in a template.
 *
 * The parent is named by `code` and not by id, because a template has no ids —
 * `applyChartTemplate` resolves each code against the account it has just created.
 */
export interface ChartTemplateAccount {
  readonly code: string;
  readonly name: string;
  readonly type: AccountType;
  readonly normalBalance: NormalBalance;
  /** A code appearing earlier in the same template, or `null` for a top-level account. */
  readonly parentCode: string | null;
  readonly description?: string;
}

export interface ChartTemplate {
  readonly id: ChartTemplateId;
  readonly name: string;
  readonly description: string;
  /**
   * Parents before children, and that order is load-bearing: the application walks
   * this array once and resolves `parentCode` against what it has already created,
   * so a forward reference is an authoring mistake rather than a reason for a second
   * pass. `test/accounts/chart-templates.test.ts` asserts it for every shipped
   * template.
   */
  readonly accounts: readonly ChartTemplateAccount[];
}

/**
 * Positional arguments rather than fifty-five object literals.
 *
 * The content of this file is what has to be reviewed, and it is reviewed by
 * scanning columns: every row is `code, name, type, normalBalance, parent`, so a
 * mistyped type or an inverted normal balance shows up as an odd word in a column of
 * identical ones. Object literals would put each account on eight lines under
 * Prettier's 100-column wrap, at which point the chart stops looking like a chart and
 * the four contra accounts stop being visible at a glance.
 */
function account(
  code: string,
  name: string,
  type: AccountType,
  normalBalance: NormalBalance,
  parentCode: string | null,
  description?: string,
): ChartTemplateAccount {
  return {
    code,
    name,
    type,
    normalBalance,
    parentCode,
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * A general chart for a small business selling goods, services, or both.
 *
 * Two generations deep, never more. The hierarchy is used for the groupings that are
 * genuine subtotals on a statement — current versus fixed assets, cost of sales
 * versus operating expenses, operating versus other — and for nothing decorative.
 * `ACCOUNT_MAX_DEPTH` permits six; a starter chart that used them would hand a new
 * org a structure to maintain rather than one to post into, and a business wanting to
 * slice by department, project or location wants dimensions (OB-033) instead of a
 * deeper chart.
 */
const GENERAL_SMALL_BUSINESS: ChartTemplate = {
  id: 'general_small_business',
  name: 'General small business',
  description:
    'A starting chart for a small business selling goods, services, or both: bank and ' +
    'receivables, payables and payroll, owner equity, revenue, cost of sales, and operating ' +
    'expenses. Around sixty accounts grouped two levels deep. Delete what you do not need — an ' +
    'account with no postings deletes outright.',
  accounts: [
    account('1000', 'Current assets', 'asset', 'debit', null),
    account('1010', 'Business checking', 'asset', 'debit', '1000'),
    account('1020', 'Business savings', 'asset', 'debit', '1000'),
    account('1050', 'Petty cash', 'asset', 'debit', '1000'),
    account(
      '1060',
      'Undeposited funds',
      'asset',
      'debit',
      '1000',
      'Payments received but not yet taken to the bank. Clears into a bank account on deposit.',
    ),
    account('1100', 'Accounts receivable', 'asset', 'debit', '1000'),
    account(
      '1150',
      'Allowance for doubtful accounts',
      'asset',
      'credit',
      '1000',
      'Contra asset: an estimate of the receivables that will not be collected, held against ' +
        'account 1100 rather than written off it. Its normal balance is credit, which is what ' +
        'makes the current-assets subtotal net of it.',
    ),
    account('1200', 'Inventory', 'asset', 'debit', '1000'),
    account('1300', 'Prepaid expenses', 'asset', 'debit', '1000'),
    account('1400', 'Employee advances', 'asset', 'debit', '1000'),

    account('1500', 'Fixed assets', 'asset', 'debit', null),
    account('1510', 'Equipment', 'asset', 'debit', '1500'),
    account('1520', 'Furniture and fixtures', 'asset', 'debit', '1500'),
    account('1530', 'Vehicles', 'asset', 'debit', '1500'),
    account('1540', 'Leasehold improvements', 'asset', 'debit', '1500'),
    account(
      '1590',
      'Accumulated depreciation',
      'asset',
      'credit',
      '1500',
      'Contra asset: depreciation charged against the accounts above since they were bought. ' +
        'Its normal balance is credit, so the fixed-assets subtotal is net book value rather ' +
        'than cost.',
    ),

    account('2000', 'Current liabilities', 'liability', 'credit', null),
    account('2010', 'Accounts payable', 'liability', 'credit', '2000'),
    account('2050', 'Credit cards payable', 'liability', 'credit', '2000'),
    account('2100', 'Accrued liabilities', 'liability', 'credit', '2000'),
    account('2200', 'Sales tax payable', 'liability', 'credit', '2000'),
    account('2300', 'Payroll liabilities', 'liability', 'credit', '2000'),
    account('2350', 'Income tax payable', 'liability', 'credit', '2000'),
    account(
      '2400',
      'Unearned revenue',
      'liability',
      'credit',
      '2000',
      'Money taken for work not yet done — a deposit, or a prepaid subscription. It is a ' +
        'liability until the work is delivered, at which point it moves to a revenue account.',
    ),

    account('2700', 'Long-term liabilities', 'liability', 'credit', null),
    account('2710', 'Notes payable', 'liability', 'credit', '2700'),
    account('2720', 'Equipment loans', 'liability', 'credit', '2700'),

    account('3000', 'Owner contributions', 'equity', 'credit', null),
    account(
      '3100',
      'Owner draws',
      'equity',
      'debit',
      null,
      'Contra equity: money the owner has taken out of the business. Its normal balance is ' +
        'debit, so it reduces equity. It is not an expense and appears on no profit and loss.',
    ),
    account(
      '3900',
      'Retained earnings',
      'equity',
      'credit',
      null,
      'Accumulated profit from prior years. OpenBooks posts no year-end closing journal ' +
        '(ROADMAP D-20), so the current year’s result is derived and presented as its own line ' +
        'on the balance sheet rather than landing here.',
    ),

    account('4000', 'Operating revenue', 'revenue', 'credit', null),
    account('4010', 'Product sales', 'revenue', 'credit', '4000'),
    account('4020', 'Service revenue', 'revenue', 'credit', '4000'),
    account(
      '4090',
      'Sales returns and allowances',
      'revenue',
      'debit',
      '4000',
      'Contra revenue: refunds, credits and discounts given after the sale. Its normal balance ' +
        'is debit, so operating revenue subtotals to net sales while 4010 and 4020 keep showing ' +
        'what was sold.',
    ),

    account('4500', 'Other income', 'revenue', 'credit', null),
    account('4510', 'Interest income', 'revenue', 'credit', '4500'),

    account('5000', 'Cost of sales', 'expense', 'debit', null),
    account('5010', 'Materials and supplies', 'expense', 'debit', '5000'),
    account('5020', 'Direct labor', 'expense', 'debit', '5000'),
    account('5030', 'Subcontractors', 'expense', 'debit', '5000'),
    account('5040', 'Freight and delivery', 'expense', 'debit', '5000'),
    account('5050', 'Merchant and processing fees', 'expense', 'debit', '5000'),

    account('6000', 'Operating expenses', 'expense', 'debit', null),
    account('6010', 'Advertising and marketing', 'expense', 'debit', '6000'),
    account('6020', 'Bank fees', 'expense', 'debit', '6000'),
    account('6030', 'Depreciation expense', 'expense', 'debit', '6000'),
    account('6040', 'Dues and subscriptions', 'expense', 'debit', '6000'),
    account('6050', 'Insurance', 'expense', 'debit', '6000'),
    account('6060', 'Office supplies', 'expense', 'debit', '6000'),
    account('6070', 'Professional fees', 'expense', 'debit', '6000'),
    account('6080', 'Rent', 'expense', 'debit', '6000'),
    account('6090', 'Repairs and maintenance', 'expense', 'debit', '6000'),
    account('6100', 'Salaries and wages', 'expense', 'debit', '6000'),
    account('6110', 'Payroll taxes', 'expense', 'debit', '6000'),
    account('6120', 'Employee benefits', 'expense', 'debit', '6000'),
    account('6130', 'Software and technology', 'expense', 'debit', '6000'),
    account('6140', 'Telephone and internet', 'expense', 'debit', '6000'),
    account('6150', 'Travel', 'expense', 'debit', '6000'),
    account('6160', 'Meals', 'expense', 'debit', '6000'),
    account('6170', 'Utilities', 'expense', 'debit', '6000'),
    account('6180', 'Vehicle expenses', 'expense', 'debit', '6000'),
    account(
      '6900',
      'Bad debt expense',
      'expense',
      'debit',
      '6000',
      'The counterpart to account 1150 when a receivable is judged uncollectable.',
    ),

    account('7000', 'Other expenses', 'expense', 'debit', null),
    account('7010', 'Interest expense', 'expense', 'debit', '7000'),
    account('7020', 'Income tax expense', 'expense', 'debit', '7000'),
  ],
};

/**
 * Every shipped template, keyed by the token clients name it with.
 *
 * `Record<ChartTemplateId, …>` rather than an array plus a lookup, so a token added
 * to `CHART_TEMPLATE_IDS` in shared-types does not compile until a chart exists for
 * it. The failure that construction rules out is a `templateId` that validates and
 * then resolves to nothing.
 */
export const CHART_TEMPLATES: Readonly<Record<ChartTemplateId, ChartTemplate>> = {
  general_small_business: GENERAL_SMALL_BUSINESS,
};
