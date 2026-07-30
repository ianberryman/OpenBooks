import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageQueryShape } from '../wire';

/**
 * Fixed assets and their depreciation schedules (initiative L, OB-163…166; ROADMAP
 * D-113…D-116, for `0014_fixed_assets`).
 *
 * An asset carries its cost, its method and life, its in-service date, and the three
 * accounts its depreciation posts through. Registration computes a schedule — one row
 * per period — which a depreciation sweep discharges one row at a time (D-113). The
 * schedule is not a fixed recurring template precisely because a declining-balance
 * amount varies each period, which no fixed line could express.
 *
 * The two account nominations that have an org-level default (`accumulatedDepreciation`,
 * `depreciationExpense`) are nullish on create and fall back to the org's accounting
 * settings, `resolveControlAccount`'s pattern (D-115). The cost account has no org
 * default and is always named.
 */

export const FIXED_ASSET_METHODS = ['straight_line', 'declining_balance'] as const;
export type FixedAssetMethod = (typeof FIXED_ASSET_METHODS)[number];

export const fixedAssetMethodSchema = z.enum(FIXED_ASSET_METHODS).meta({
  description:
    'How depreciation is computed (D-114). `straight_line` charges `(cost − salvage) / life` each ' +
    'period; `declining_balance` charges `rate × book value`, floored at salvage, and requires ' +
    '`decliningRatePpm`. Units-of-production is out of v1 scope.',
});

export const FIXED_ASSET_STATUSES = ['active', 'disposed'] as const;
export type FixedAssetStatus = (typeof FIXED_ASSET_STATUSES)[number];

export const fixedAssetStatusSchema = z.enum(FIXED_ASSET_STATUSES).meta({
  description:
    'Whether the asset still depreciates. `disposed` is terminal (D-116): disposal posts the ' +
    'gain or loss and voids the remaining unposted schedule rows.',
});

const fixedAssetNameSchema = z.string().trim().min(1).max(255);
const fixedAssetDescriptionSchema = z.string().trim().min(1).max(512);
const usefulLifeMonthsSchema = z.int().min(1).max(1_200).meta({
  description: 'The depreciable life in whole months. At least one; a century caps the top.',
});
const decliningRatePpmSchema = z.int().min(1).max(1_000_000).meta({
  description:
    'The declining-balance rate in parts per million (`tax_rates.rate_ppm`’s convention): ' +
    'double-declining over a five-year life is `2 × 1/5 = 400000`. Required for ' +
    '`declining_balance`, and forbidden for `straight_line`, which ignores it.',
});

/**
 * `salvage ≤ cost`, and the method/rate agreement, checked here so a registration that
 * cannot compute a schedule is refused at the edge rather than at compute time — the
 * `chk_fixed_assets_*` constraints say the same thing at the database, one layer down.
 */
function assertAssetShape(
  value: {
    readonly acquisitionCostMinor: string;
    readonly salvageValueMinor: string;
    readonly method: FixedAssetMethod;
    readonly decliningRatePpm?: number | null | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (BigInt(value.salvageValueMinor) > BigInt(value.acquisitionCostMinor)) {
    ctx.addIssue({
      code: 'custom',
      message: 'Salvage value cannot exceed acquisition cost.',
      path: ['salvageValueMinor'],
    });
  }
  const hasRate = value.decliningRatePpm !== undefined && value.decliningRatePpm !== null;
  if (value.method === 'declining_balance' && !hasRate) {
    ctx.addIssue({
      code: 'custom',
      message: 'declining_balance requires decliningRatePpm.',
      path: ['decliningRatePpm'],
    });
  }
  if (value.method === 'straight_line' && hasRate) {
    ctx.addIssue({
      code: 'custom',
      message: 'straight_line does not take decliningRatePpm.',
      path: ['decliningRatePpm'],
    });
  }
}

export const createFixedAssetRequestSchema = z
  .strictObject({
    name: fixedAssetNameSchema.meta({ description: 'What the asset is called on the register.' }),
    description: fixedAssetDescriptionSchema.nullish(),
    assetAccountId: z.uuid().meta({
      description: 'The account the asset’s cost sits in. No org default — always named.',
    }),
    accumulatedDepreciationAccountId: z.uuid().nullish().meta({
      description:
        'Where accumulated depreciation accrues — an asset account carrying a credit balance ' +
        '(D-115). Null or absent defaults from the org’s accounting settings.',
    }),
    depreciationExpenseAccountId: z.uuid().nullish().meta({
      description:
        'Where each period’s depreciation charge lands (an expense). Null or absent defaults ' +
        'from the org’s accounting settings.',
    }),
    acquisitionCostMinor: minorUnitsSchema.meta({
      description: 'What the asset cost, in minor units. The top of the depreciable base.',
    }),
    salvageValueMinor: minorUnitsSchema.meta({
      description:
        'The residual value depreciation stops at, in minor units. `Σ schedule = cost − salvage` ' +
        '(L6). Send `"0"` for none.',
    }),
    method: fixedAssetMethodSchema,
    usefulLifeMonths: usefulLifeMonthsSchema,
    decliningRatePpm: decliningRatePpmSchema.nullish(),
    inServiceDate: calendarDateSchema.meta({
      description: 'The date the asset was placed in service — where the schedule begins.',
    }),
  })
  .superRefine((value, ctx) => assertAssetShape(value, ctx));

export type CreateFixedAssetRequest = z.infer<typeof createFixedAssetRequestSchema>;

/**
 * Partial update. Repointing an account is always safe; changing a depreciation
 * parameter (`method`, `salvageValueMinor`, `usefulLifeMonths`, `decliningRatePpm`,
 * `acquisitionCostMinor`, `inServiceDate`) recomputes the schedule, but only while no
 * period has posted — the service refuses a re-forecast once posting has begun (the
 * no-mid-life-re-forecast edge; the fix then is disposal + re-register).
 */
export const updateFixedAssetRequestSchema = z
  .strictObject({
    name: fixedAssetNameSchema.optional(),
    description: fixedAssetDescriptionSchema.nullish(),
    assetAccountId: z.uuid().optional(),
    accumulatedDepreciationAccountId: z.uuid().optional(),
    depreciationExpenseAccountId: z.uuid().optional(),
    acquisitionCostMinor: minorUnitsSchema.optional(),
    salvageValueMinor: minorUnitsSchema.optional(),
    method: fixedAssetMethodSchema.optional(),
    usefulLifeMonths: usefulLifeMonthsSchema.optional(),
    decliningRatePpm: decliningRatePpmSchema.nullish(),
    inServiceDate: calendarDateSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  });

export type UpdateFixedAssetRequest = z.infer<typeof updateFixedAssetRequestSchema>;

export const fixedAssetSchema = z.strictObject({
  id: z.uuid(),
  name: fixedAssetNameSchema,
  description: z.string().nullable(),
  assetAccountId: z.uuid(),
  accumulatedDepreciationAccountId: z.uuid(),
  depreciationExpenseAccountId: z.uuid(),
  acquisitionCostMinor: minorUnitsSchema,
  salvageValueMinor: minorUnitsSchema,
  method: fixedAssetMethodSchema,
  usefulLifeMonths: usefulLifeMonthsSchema,
  decliningRatePpm: z.int().min(1).nullable(),
  inServiceDate: calendarDateSchema,
  status: fixedAssetStatusSchema,
  disposedDate: calendarDateSchema.nullable().meta({
    description: 'The date the asset was disposed, or null while active.',
  }),
  disposalJournalId: z.uuid().nullable().meta({
    description: 'The journal disposal posted (D-116), or null while active.',
  }),
});

export type FixedAsset = z.infer<typeof fixedAssetSchema>;

/** One period of the computed schedule; `postedJournalId` set means it has been posted. */
export const fixedAssetScheduleRowSchema = z.strictObject({
  periodIndex: z.int().min(0).meta({ description: 'The zero-based ordinal of this period.' }),
  periodDate: calendarDateSchema.meta({
    description: 'The date this period’s depreciation posts as of.',
  }),
  depreciationAmountMinor: minorUnitsSchema.meta({
    description: 'The depreciation charged in this period, in minor units.',
  }),
  postedJournalId: z.uuid().nullable().meta({
    description:
      'The journal that discharged this period, or null while unposted — the once-per-period ' +
      'idempotency key (L3).',
  }),
});

export type FixedAssetScheduleRow = z.infer<typeof fixedAssetScheduleRowSchema>;

export const fixedAssetScheduleSchema = z.strictObject({
  assetId: z.uuid(),
  rows: z.array(fixedAssetScheduleRowSchema),
});

export type FixedAssetSchedule = z.infer<typeof fixedAssetScheduleSchema>;

export const disposeFixedAssetRequestSchema = z
  .strictObject({
    date: calendarDateSchema.meta({
      description:
        'The disposal date; the disposal journal posts as of it (must fall in an open period).',
    }),
    proceedsMinor: minorUnitsSchema.meta({
      description:
        'What was received on disposal, in minor units. Gain or loss is proceeds less the asset’s ' +
        'net book value; send `"0"` for a write-off.',
    }),
    proceedsAccountId: z.uuid().nullish().meta({
      description:
        'Where the disposal proceeds land — a cash, bank, or clearing account. Required when ' +
        '`proceedsMinor` is non-zero; null or absent for a write-off with no proceeds.',
    }),
    gainLossAccountId: z.uuid().meta({
      description:
        'The P&L account the disposal gain or loss posts to. A gain credits it, a loss debits ' +
        'it; a break-even disposal posts no line to it.',
    }),
  })
  .superRefine((value, ctx) => {
    if (BigInt(value.proceedsMinor) > 0n && (value.proceedsAccountId ?? null) === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'proceedsAccountId is required when proceedsMinor is non-zero.',
        path: ['proceedsAccountId'],
      });
    }
  });

export type DisposeFixedAssetRequest = z.infer<typeof disposeFixedAssetRequestSchema>;

export const listFixedAssetsQuerySchema = z.strictObject({
  ...pageQueryShape,
  status: fixedAssetStatusSchema.optional(),
});

export type ListFixedAssetsQuery = z.input<typeof listFixedAssetsQuerySchema>;

// The keyset page schema (`pageSchema(...)`) carries a `.meta({ id })` and so enters
// `components.schemas`; it is added with the `/v1` routes in OB-167 (Wave 2), when the
// OpenAPI artifact is regenerated in the same change — see this package's index header.
