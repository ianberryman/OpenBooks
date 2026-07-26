import { z } from 'zod';

import { ACCOUNT_TYPES, NORMAL_BALANCES } from '../accounts';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

/**
 * The trial balance wire contract (OB-023; acceptance A2).
 *
 * Every amount is a cents-only string (D-13), including the totals and the
 * difference. The aggregation is exact — `SUM` over two non-negative `BIGINT`
 * columns, normalized through `BigInt` — and putting any of it in a JSON number
 * would surrender that at the one place we do not control, the client's parser.
 */

export const trialBalanceRowSchema = z
  .strictObject({
    accountId: z.uuid(),
    code: z.string(),
    name: z.string(),
    type: z.enum(ACCOUNT_TYPES),
    normalBalance: z.enum(NORMAL_BALANCES),
    debits: minorUnitsSchema,
    credits: minorUnitsSchema,
    balance: minorUnitsSchema.meta({
      description: '`debits - credits`. Negative means the account is net credit.',
    }),
  })
  .meta({
    id: 'TrialBalanceRow',
    description:
      'One account’s totals. Accounts with no postings appear with zeros — a trial balance that ' +
      'silently omitted them would hide a chart-of-accounts mistake exactly when someone is ' +
      'looking for one.',
  });

export const trialBalanceSchema = z
  .strictObject({
    asOf: calendarDateSchema.nullable().meta({
      description: 'The upper bound that was applied, or null when every posting to date is in.',
    }),
    rows: z.array(trialBalanceRowSchema),
    totalDebits: minorUnitsSchema,
    totalCredits: minorUnitsSchema,
    /**
     * Reported, not asserted. This endpoint says what the ledger contains; a
     * non-zero difference is a fact an operator needs to see, not an exception to
     * swallow. Turning it into an alert is the integrity job's business (spec §11).
     */
    difference: minorUnitsSchema.meta({
      description:
        '`totalDebits - totalCredits`. Always `"0"` for a consistent ledger. Reported rather ' +
        'than asserted, so a discrepancy is visible instead of being converted into an error.',
    }),
  })
  .meta({
    id: 'TrialBalance',
    description:
      'Debit and credit totals per account plus the org-wide totals, which must be equal. A ' +
      'direct aggregation over journal lines — there is no balance cache anywhere in M1.',
  });

/**
 * `asOf` is an inclusive upper bound on the entry date. Omitting it means every
 * posting to date.
 */
export const trialBalanceQuerySchema = z
  .strictObject({
    asOf: calendarDateSchema.optional(),
  })
  .meta({ description: 'Omitting `asOf` includes every posting to date.' });

export type TrialBalanceQueryParams = z.infer<typeof trialBalanceQuerySchema>;
