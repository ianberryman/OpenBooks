import { z } from 'zod';

import { compare, fromMinorString, isNegative, isPositive } from '../money';
import { calendarDateSchema, minorUnitsSchema, pageCursorSchema, pageQueryShape } from '../wire';

/**
 * Fixed assets: the register, its precomputed depreciation schedule, and disposal
 * (initiative L, OB-163…166; ROADMAP D-113…D-117).
 *
 * ## No `.meta({ id })` here yet
 *
 * The routes arrive in a later stream (OB-167), and an `id` with no route
 * publishes a `components.schemas` entry nothing can reach — the sequence
 * `payments-processing/connections.ts` already describes for the same reason. The
 * ids land in the same diff as the routes; until then these carry descriptions and
 * no id.
 *
 * ## Why registration takes cost, salvage, method and life, and never a schedule
 *
 * `fixedAssetScheduleRowSchema` never appears on `createFixedAssetRequestSchema`.
 * The schedule is *computed*, by `computeDepreciationSchedule` — a pure function
 * of the five fields this request does carry — never supplied, for the same
 * reason a document line never carries its own tax amount pre-computed
 * (`0005_subledger`'s single-rounding-point argument): a client-supplied schedule
 * could disagree with what the server would have computed, and there would be two
 * answers to "how much does this asset depreciate in April" with nothing to
 * prefer one.
 *
 * ## Why `decliningRatePpm` is paired with `method`, not independently optional
 *
 * A declining-balance asset without a rate has nothing to decline by, and a
 * straight-line asset with one is a value nobody asked for and nothing will ever
 * read (D-114) — `chk_fixed_assets_declining_rate` enforces the same pairing at
 * the schema, and `updateFixedAssetRequestSchema` deliberately does not restate
 * the refinement: an update may change `method` and `decliningRatePpm` in
 * different requests, and the service — which already holds the current row —
 * is where the merged pair is actually known to agree.
 *
 * ## Why account nominations are optional on create
 *
 * `assetAccountId` is required — an asset registered with no account to reside on
 * is not a registration — but `accumulatedDepreciationAccountId` and
 * `depreciationExpenseAccountId` are not: `fixed-assets.service.ts` falls back to
 * the org's own defaults (`org_accounting_settings.accumulated_depreciation_account_id`
 * / `.depreciation_expense_account_id`, `0005_subledger`) when either is absent, the
 * same "nominate once, reuse everywhere" shape `control-accounts.ts` established.
 * An org with no default and no per-asset override gets a `precondition_failed`
 * naming the missing nomination rather than a silent guess.
 */

export const FIXED_ASSET_METHODS = ['straight_line', 'declining_balance'] as const;
export type FixedAssetMethod = (typeof FIXED_ASSET_METHODS)[number];

export const fixedAssetMethodSchema = z.enum(FIXED_ASSET_METHODS).meta({
  description:
    'How the asset depreciates. `straight_line` charges an equal amount every period; ' +
    '`declining_balance` charges a fixed rate of the remaining book value, floored at salvage ' +
    '(D-114). Units-of-production is deferred.',
});

export const FIXED_ASSET_STATUSES = ['active', 'disposed'] as const;
export type FixedAssetStatus = (typeof FIXED_ASSET_STATUSES)[number];

export const fixedAssetStatusSchema = z.enum(FIXED_ASSET_STATUSES).meta({
  description:
    'Whether the asset is still depreciating. `disposed` is set once, by `disposeFixedAsset` ' +
    '(D-116) — there is no path back to `active`, the same one-way shape a voided document takes.',
});

const FIXED_ASSET_NAME_MAX_LENGTH = 255;
const FIXED_ASSET_DESCRIPTION_MAX_LENGTH = 1000;

/** `rate_ppm`'s convention (`tax_rates`, `payment_terms`): parts per million, not a `DECIMAL`. */
const DECLINING_RATE_PPM_MAX = 1_000_000;

const fixedAssetNameSchema = z.string().trim().min(1).max(FIXED_ASSET_NAME_MAX_LENGTH);
const fixedAssetDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(FIXED_ASSET_DESCRIPTION_MAX_LENGTH);

const fixedAssetCreateShape = {
  name: fixedAssetNameSchema.meta({
    description: 'What this asset is called in the register — a label, not an accounting code.',
  }),
  description: fixedAssetDescriptionSchema.nullish(),
  assetAccountId: z.uuid().meta({
    description: 'The ledger account this asset’s cost sits on.',
  }),
  accumulatedDepreciationAccountId: z
    .uuid()
    .optional()
    .meta({
      description:
        'The account depreciation credits, period after period. Absent falls back to the org’s ' +
        'default (`depreciation-accounts.ts`); absent with no default is a `precondition_failed`.',
    }),
  depreciationExpenseAccountId: z.uuid().optional().meta({
    description: 'The account each posted period debits. Absent falls back to the org’s default.',
  }),
  acquisitionCostMinor: minorUnitsSchema.meta({
    description:
      'What the asset cost. Must exceed `salvageValueMinor` — there is nothing to ' +
      'depreciate otherwise.',
  }),
  salvageValueMinor: minorUnitsSchema.meta({
    description: 'The residual value the schedule depreciates down to and never below (L6).',
  }),
  method: fixedAssetMethodSchema,
  usefulLifeMonths: z
    .int()
    .min(1)
    .meta({
      description:
        'How many monthly periods the schedule runs — `computeDepreciationSchedule`’s ' +
        'own period count.',
    }),
  decliningRatePpm: z
    .int()
    .min(1)
    .max(DECLINING_RATE_PPM_MAX)
    .nullish()
    .meta({
      description:
        'Required, and only meaningful, when `method` is `declining_balance` — the fixed rate ' +
        'of remaining book value each period charges, in parts per million. Must be omitted or ' +
        'null for `straight_line`.',
    }),
  inServiceDate: calendarDateSchema.meta({
    description: 'The date depreciation begins. Period 0 of the schedule is dated here.',
  }),
};

/** True exactly when `decliningRatePpm` is present and non-null — the schema half of D-114's pairing. */
function hasDecliningRate(value: number | null | undefined): boolean {
  return value !== null && value !== undefined;
}

export const createFixedAssetRequestSchema = z
  .strictObject(fixedAssetCreateShape)
  .refine(
    (input) => (input.method === 'declining_balance') === hasDecliningRate(input.decliningRatePpm),
    {
      message:
        'decliningRatePpm is required for a declining_balance asset and must be omitted (or null) ' +
        'for a straight_line one.',
      path: ['decliningRatePpm'],
    },
  )
  .refine(
    (input) => {
      try {
        return isPositive(fromMinorString(input.acquisitionCostMinor));
      } catch {
        // `minorUnitsSchema`'s own field-level refinement already reports a
        // malformed amount; this refine is only about the sign and should not
        // duplicate that error.
        return true;
      }
    },
    { message: 'acquisitionCostMinor must be greater than zero.', path: ['acquisitionCostMinor'] },
  )
  .refine(
    (input) => {
      try {
        return !isNegative(fromMinorString(input.salvageValueMinor));
      } catch {
        return true;
      }
    },
    {
      message: 'salvageValueMinor must not be negative — chk_fixed_assets_salvage.',
      path: ['salvageValueMinor'],
    },
  )
  .refine(
    (input) => {
      try {
        return (
          compare(
            fromMinorString(input.acquisitionCostMinor),
            fromMinorString(input.salvageValueMinor),
          ) === 1
        );
      } catch {
        return true;
      }
    },
    {
      message:
        'acquisitionCostMinor must be greater than salvageValueMinor — chk_fixed_assets_salvage.',
      path: ['salvageValueMinor'],
    },
  )
  .meta({
    description:
      'Registers a fixed asset and computes its depreciation schedule (OB-163, OB-164). The ' +
      'schedule itself is never supplied — it is computed from the fields here and nothing else.',
  });

export type CreateFixedAssetRequest = z.infer<typeof createFixedAssetRequestSchema>;

/**
 * A partial update. Repointing an account, or correcting `name`/`description`, is
 * always accepted. Changing anything the schedule was computed from — `method`,
 * `salvageValueMinor`, `usefulLifeMonths`, `decliningRatePpm`, `acquisitionCostMinor`
 * or `inServiceDate` — is accepted only while no period has posted; once one has,
 * the service refuses with `fixed_asset_has_posted_depreciation` rather than
 * silently re-forecasting a schedule whose early periods already posted under the
 * old numbers (ROADMAP "no mid-life re-forecast in v1").
 *
 * `decliningRatePpm`/`method`'s pairing is not re-validated here — see the file
 * header. The service checks the pair as it stands after the patch is applied.
 */
export const updateFixedAssetRequestSchema = z
  .strictObject({
    name: fixedAssetCreateShape.name.optional(),
    description: fixedAssetDescriptionSchema.nullish(),
    assetAccountId: fixedAssetCreateShape.assetAccountId.optional(),
    accumulatedDepreciationAccountId: z.uuid().optional(),
    depreciationExpenseAccountId: z.uuid().optional(),
    acquisitionCostMinor: minorUnitsSchema.optional(),
    salvageValueMinor: minorUnitsSchema.optional(),
    method: fixedAssetMethodSchema.optional(),
    usefulLifeMonths: z.int().min(1).optional(),
    decliningRatePpm: z.int().min(1).max(DECLINING_RATE_PPM_MAX).nullish(),
    inServiceDate: calendarDateSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    description:
      'Partial update of a fixed asset. Account repointing and the name/description are always ' +
      'accepted; changing a depreciation parameter once a period has posted is a ' +
      '`precondition_failed` (no mid-life re-forecast in v1).',
  });

export type UpdateFixedAssetRequest = z.infer<typeof updateFixedAssetRequestSchema>;

export const fixedAssetSchema = z
  .strictObject({
    id: z.uuid(),
    name: fixedAssetCreateShape.name,
    description: z.string().nullable(),
    assetAccountId: z.uuid(),
    accumulatedDepreciationAccountId: z.uuid(),
    depreciationExpenseAccountId: z.uuid(),
    acquisitionCostMinor: minorUnitsSchema,
    salvageValueMinor: minorUnitsSchema,
    method: fixedAssetMethodSchema,
    usefulLifeMonths: z.int().min(1),
    decliningRatePpm: z.int().nullable(),
    inServiceDate: calendarDateSchema,
    status: fixedAssetStatusSchema,
    disposedDate: calendarDateSchema.nullable(),
    disposalJournalId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    description:
      'A registered fixed asset (OB-163). `accumulatedDepreciationAccountId` and ' +
      '`depreciationExpenseAccountId` are always concrete ids on the response even when the ' +
      'create request left one to the org’s default — the resolved id, not the absence, is what ' +
      'a client needs to show.',
  });

export type FixedAsset = z.infer<typeof fixedAssetSchema>;

export const listFixedAssetsQuerySchema = z.strictObject({
  ...pageQueryShape,
  status: fixedAssetStatusSchema.optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListFixedAssetsQuery = z.input<typeof listFixedAssetsQuerySchema>;

/**
 * One page of the register, oldest first (D-21) — `accountPageSchema`'s own
 * ordering reasoning: `name` and every depreciation field are mutable up to the
 * point a period posts, so a keyset must not sort on any of them.
 *
 * Built by hand rather than through `pageSchema()`: that helper requires a
 * `.meta({ id })`, and this file's own header is explicit that no id lands before
 * OB-167's routes do.
 */
export const fixedAssetPageSchema = z
  .strictObject({
    items: z.array(fixedAssetSchema),
    nextCursor: pageCursorSchema.nullable(),
  })
  .meta({ description: 'One page of the org’s fixed-asset register, oldest first by creation.' });

export type FixedAssetPage = z.infer<typeof fixedAssetPageSchema>;

/** One period of a fixed asset's depreciation schedule (OB-164). */
export const fixedAssetScheduleRowSchema = z
  .strictObject({
    periodIndex: z.int().min(0),
    periodDate: calendarDateSchema,
    depreciationAmountMinor: minorUnitsSchema,
    postedJournalId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'Null while the period is still due; set once the daily sweep posts it (D-113). Set is ' +
          'permanent — a posted period is never reopened.',
      }),
  })
  .meta({
    description:
      'One period of a fixed asset’s precomputed depreciation schedule. `Σ depreciationAmountMinor` ' +
      'over every row equals `acquisitionCostMinor − salvageValueMinor` exactly (L6).',
  });

export type FixedAssetScheduleRow = z.infer<typeof fixedAssetScheduleRowSchema>;

export const fixedAssetScheduleSchema = z.array(fixedAssetScheduleRowSchema).meta({
  description: 'A fixed asset’s whole depreciation schedule, ordered by `periodIndex`.',
});

export type FixedAssetSchedule = z.infer<typeof fixedAssetScheduleSchema>;

/**
 * Disposes a fixed asset: recognises the gain or loss against proceeds, and
 * stops the schedule (OB-166; D-116). Full disposal only.
 *
 * `proceedsAccountId` is required only when `proceedsMinor` is greater than
 * zero — an asset disposed for nothing has no cash or receivable side to the
 * entry. `gainLossAccountId` is always required: the service computes the gain
 * or loss and, on the one occasion it is exactly zero, simply posts no third
 * line — the account is still named up front so a caller never has to guess
 * whether this disposal will need it.
 */
export const disposeFixedAssetRequestSchema = z
  .strictObject({
    date: calendarDateSchema.meta({ description: 'The date the disposal journal posts on.' }),
    proceedsMinor: minorUnitsSchema.meta({
      description: 'What was received for the asset, if anything. `"0"` for a scrapped asset.',
    }),
    proceedsAccountId: z
      .uuid()
      .optional()
      .meta({
        description:
          'The account debited for proceeds received (cash, or a receivable). Required when ' +
          '`proceedsMinor` is greater than zero; meaningless and ignored at zero.',
      }),
    gainLossAccountId: z.uuid().meta({
      description:
        'The account the gain or loss on disposal posts to. Always required; a disposal that ' +
        'happens to break exactly even simply posts no line to it.',
    }),
  })
  .refine(
    (input) => {
      try {
        return !isNegative(fromMinorString(input.proceedsMinor));
      } catch {
        return true;
      }
    },
    {
      // Negative proceeds is not "money paid to keep the asset" on any real
      // disposal; left unrefused it would silently understate the loss line
      // below (`disposeFixedAsset`'s own arithmetic assumes `proceeds >= 0`)
      // and surface, confusingly, as `postJournal`'s generic "does not balance"
      // rather than a refusal that names the field.
      message: 'proceedsMinor must not be negative.',
      path: ['proceedsMinor'],
    },
  )
  .refine(
    (input) => {
      try {
        return (
          !isPositive(fromMinorString(input.proceedsMinor)) || input.proceedsAccountId !== undefined
        );
      } catch {
        // `minorUnitsSchema`'s own refinement already reports a malformed amount;
        // this refine is only about the pairing and should not duplicate that error.
        return true;
      }
    },
    {
      message: 'proceedsAccountId is required when proceedsMinor is greater than zero.',
      path: ['proceedsAccountId'],
    },
  )
  .meta({
    description:
      'Disposes a fixed asset (D-116): a fresh journal recognises the gain or loss against ' +
      'proceeds, the asset moves to `disposed`, and its remaining unposted schedule rows are ' +
      'discarded. There is no reversal of depreciation already posted.',
  });

export type DisposeFixedAssetRequest = z.infer<typeof disposeFixedAssetRequestSchema>;

/**
 * The org's depreciation-account defaults (`0005_subledger`'s in-place addition to
 * `org_accounting_settings`), mirroring `controlAccountsSchema`/`discountAccountsSchema`
 * verbatim (`orgs/settings.ts`) — the same kind of setting, D-115's per-asset
 * nomination falling back to these when an asset registration or update leaves
 * one unset. Kept in this file rather than `orgs/settings.ts` because both fields
 * exist for fixed assets alone and nothing there yet depends on them.
 */
export const depreciationAccountsSchema = z
  .strictObject({
    depreciationExpenseAccountId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The org-default account each posted depreciation period debits, when an asset does not ' +
          'name its own. Null until nominated.',
      }),
    accumulatedDepreciationAccountId: z
      .uuid()
      .nullable()
      .meta({
        description:
          'The org-default account depreciation credits, when an asset does not name its own. Null ' +
          'until nominated.',
      }),
  })
  .meta({
    description:
      'The org’s default depreciation accounts (D-115), consulted only when a fixed asset does ' +
      'not nominate its own. Either may be null — an org with no registered assets yet has ' +
      'nominated neither.',
  });

export type DepreciationAccounts = z.infer<typeof depreciationAccountsSchema>;

/**
 * A partial update, `updateControlAccountsRequestSchema`'s own distinction: an
 * omitted field is left alone, an explicit `null` clears the nomination.
 */
export const updateDepreciationAccountsRequestSchema = z
  .strictObject({
    depreciationExpenseAccountId: z.uuid().nullable().optional(),
    accumulatedDepreciationAccountId: z.uuid().nullable().optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    description:
      'Partial update of the org’s default depreciation accounts. An omitted field is left as it ' +
      'is; an explicit `null` clears the nomination. Changing a default reaches only assets ' +
      'registered after the change — an asset already registered keeps the accounts it resolved ' +
      'at registration.',
  });

export type UpdateDepreciationAccountsRequest = z.infer<
  typeof updateDepreciationAccountsRequestSchema
>;
