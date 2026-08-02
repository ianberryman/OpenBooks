import { z } from 'zod';

import { payoutSyncModeSchema } from './connections';

/**
 * Automatic payout sync → summary-sales journals (OB-237). The account mapping an
 * org configures once per connection, and the payout-sync staging rows a human
 * reviews and posts (D-237-2). Money is a cents-only string on the wire (D-13),
 * validated server-side by `fromMinorString`; nothing here is a decimal or a
 * JSON number. See ROADMAP OB-237 for the settled forks (D-237-1…7).
 */

/**
 * The reporting categories a payout breaks down into — the account-mapping key
 * (D-237-6), mirroring `PayoutReportingCategory` in `@openbooks/plugin-api`. A
 * closed set; the DB column is `VARCHAR + CHECK` (`0024_payout_sync`).
 */
export const PAYOUT_REPORTING_CATEGORIES = [
  'charge',
  'refund',
  'fee',
  'tax',
  'dispute',
  'adjustment',
] as const;

export type PayoutReportingCategory = (typeof PAYOUT_REPORTING_CATEGORIES)[number];

export const payoutReportingCategorySchema = z.enum(PAYOUT_REPORTING_CATEGORIES).meta({
  description:
    'Which kind of payout line a mapping row places (D-237-6): `charge`→revenue, ' +
    '`refund`→contra-revenue, `fee`→fee account, `tax`→Sales Tax Payable, ' +
    '`dispute`→loss, `adjustment`→catch-all. The clearing plug is always the ' +
    'connection’s own clearing account, never mapped here.',
});

/** One `reporting_category → GL account` mapping row (D-237-6). */
export const payoutAccountMapEntrySchema = z
  .strictObject({
    reportingCategory: payoutReportingCategorySchema,
    accountId: z.uuid().meta({
      description:
        'The ledger account this category posts to — an account the org already has (D-23).',
    }),
  })
  .meta({
    id: 'PayoutAccountMapEntry',
    description:
      'A reporting_category → GL account mapping row for a payout-sync connection (OB-237).',
  });

export type PayoutAccountMapEntry = z.infer<typeof payoutAccountMapEntrySchema>;

/**
 * Configures a connection's payout sync (D-237-1, D-237-2, D-237-6): the mode,
 * whether summaries auto-post, and the full category→account mapping. The mapping
 * is replaced wholesale (the `bank_rules` edit shape) rather than patched row by
 * row — the screen always sends the complete set it is showing.
 */
export const updatePayoutSyncConfigRequestSchema = z
  .strictObject({
    syncMode: payoutSyncModeSchema,
    autoPost: z.boolean().meta({
      description:
        'Whether each payout’s summary journal posts automatically or is held for review (D-237-2).',
    }),
    entries: z.array(payoutAccountMapEntrySchema).meta({
      description:
        'The complete category→account mapping. Replaced wholesale; a category with no entry ' +
        'that appears in a payout sends that sync to `skipped` rather than mis-posting.',
    }),
  })
  .meta({
    id: 'UpdatePayoutSyncConfigRequest',
    description:
      'Sets a connection’s payout-sync mode, auto-post, and category→account mapping (OB-237).',
  });

export type UpdatePayoutSyncConfigRequest = z.infer<typeof updatePayoutSyncConfigRequestSchema>;

/** A connection's payout-sync configuration as the API returns it (OB-237). */
export const payoutSyncConfigSchema = z
  .strictObject({
    connectionId: z.uuid(),
    syncMode: payoutSyncModeSchema,
    autoPost: z.boolean(),
    entries: z.array(payoutAccountMapEntrySchema),
  })
  .meta({
    id: 'PayoutSyncConfig',
    description:
      'A connection’s payout-sync mode, auto-post, and category→account mapping (OB-237).',
  });

export type PayoutSyncConfig = z.infer<typeof payoutSyncConfigSchema>;

/** One category's rolled-up magnitude within a payout (a cents string, D-13). */
export const payoutSyncCategoryLineSchema = z.strictObject({
  reportingCategory: payoutReportingCategorySchema,
  amountMinor: z
    .string()
    .meta({ description: 'Non-negative magnitude for this category, cents-only (D-13).' }),
  count: z.number().int().nonnegative(),
});

export const PAYOUT_SYNC_STATUSES = ['pending_review', 'posted', 'skipped'] as const;

export const payoutSyncStatusSchema = z.enum(PAYOUT_SYNC_STATUSES).meta({
  description:
    'A payout sync’s lifecycle (D-237-2): `pending_review` awaits a human, `posted` has a ' +
    'summary journal, `skipped` was declined (unmapped category, non-usd) with a reason.',
});

/**
 * One payout-sync staging row as the API returns it (D-237-2) — the grossed-up
 * breakdown a human reviews and posts. `journalId` is set once posted; `breakdown`
 * is the per-category aggregation the summary journal was built from.
 */
export const payoutSyncSchema = z
  .strictObject({
    id: z.uuid(),
    connectionId: z.uuid(),
    externalPayoutId: z.string(),
    grossMinor: z
      .string()
      .meta({ description: 'Gross sales + tax for the payout, cents-only (D-13).' }),
    feeMinor: z
      .string()
      .meta({ description: 'Total processor fees for the payout, cents-only (D-13).' }),
    netMinor: z
      .string()
      .meta({ description: 'The net payout amount — the clearing plug, cents-only (D-13).' }),
    currency: z.string(),
    status: payoutSyncStatusSchema,
    breakdown: z.array(payoutSyncCategoryLineSchema),
    journalId: z
      .uuid()
      .nullable()
      .meta({ description: 'The posted summary journal, once posted.' }),
    skipReason: z.string().nullable(),
    occurredAt: z.iso.datetime(),
    postedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'PayoutSync',
    description: 'A payout-sync staging row a human reviews and posts (OB-237, D-237-2).',
  });

export type PayoutSync = z.infer<typeof payoutSyncSchema>;
