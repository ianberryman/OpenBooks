import { z } from 'zod';

/**
 * Request and response schemas for the chart of accounts (OB-018).
 *
 * ## Why the schemas are here and the enforcement is not
 *
 * Spec §3 makes these the single source of truth for validation, the TypeScript
 * types, and the published OpenAPI document, so OB-023's routes and OB-024's
 * generated client both read them from here. What stays on the server is
 * everything that needs authority or state: `requirePermission` (spec §2.4 —
 * service layer only), the duplicate-code conflict, and the has-postings checks.
 * A schema knows nothing about the caller, which is why it is safe to share.
 *
 * ## No `id` in `.meta()`, deliberately
 *
 * `jsonSchemaTransformObject`, registered in `src/transport/openapi.ts`, copies
 * *every* schema carrying an `id` out of zod's global registry into
 * `components.schemas` — the whole registry, not the subset some route
 * references (`fastify-type-provider-zod`'s `copyRegistry` iterates `_idmap`).
 * `.meta({ id })` executes at module evaluation, and this module is evaluated in
 * the API process as soon as anything imports `@openbooks/shared-types`, which
 * `src/modules/idempotency/response.ts` already does.
 *
 * So an `id` here would add two components — `Account` and `AccountInput`, one
 * per io direction — to `openapi.json` before a single account route exists, and
 * A10 makes any drift in that file a build failure. Descriptions are free
 * because they are only read through a schema that is actually referenced.
 *
 * The `id`s belong to OB-023, added alongside the routes that reference them, so
 * the artifact and the route table move in one diff.
 */

/**
 * Spec §2.1's five account types, matching the `ENUM` in `0002_ledger`.
 *
 * Exported as a value as well as a type because OB-023 needs the list for a
 * filter and the seeded chart-of-accounts templates in M2 will need it too;
 * re-deriving it from `z.enum(...).options` reads worse at those call sites.
 */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ['debit', 'credit'] as const;

export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/**
 * Column widths, restated from `0002_ledger`.
 *
 * MySQL's `VARCHAR(n)` counts characters and JavaScript's `String.length` counts
 * UTF-16 code units, and the inequality runs the safe way: an astral character
 * costs 2 in JS and 1 in MySQL, so `length <= n` implies `CHAR_LENGTH <= n`.
 * A value this schema accepts therefore cannot be truncated by the column, which
 * is the direction that matters — silent truncation of an account code would
 * produce two accounts that look identical in every report.
 */
export const ACCOUNT_CODE_MAX_LENGTH = 32;
export const ACCOUNT_NAME_MAX_LENGTH = 255;
export const ACCOUNT_DESCRIPTION_MAX_LENGTH = 512;

const accountTypeSchema = z.enum(ACCOUNT_TYPES).meta({
  description:
    'Which of the five statement categories the account belongs to. Determines where it ' +
    'appears in reports; it does not determine `normalBalance`.',
});

const normalBalanceSchema = z.enum(NORMAL_BALANCES).meta({
  description:
    'The side that increases this account. Stored, never derived from `type`, because contra ' +
    'accounts are real: accumulated depreciation is an `asset` whose normal balance is ' +
    '`credit`, as is an allowance for doubtful accounts. No constraint ties the two fields ' +
    'together — see the `accounts` commentary in migration 0002_ledger.',
});

/**
 * `.trim()` before the length checks, so they see the stored value.
 *
 * Trimming is not cosmetic here: `uq_accounts_org_code` would treat `'1000 '` and
 * `'1000'` as two different codes, giving an org two accounts that print
 * identically in every report and reconcile to different balances. Normalizing at
 * the boundary means the constraint sees the same string the user sees.
 */
const accountCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(ACCOUNT_CODE_MAX_LENGTH)
  .meta({
    description:
      "Short reference unique within the org, e.g. `1000`. Compared under the column's " +
      '`utf8mb4_0900_ai_ci` collation, so it is case- and accent-insensitive: `1000a` and ' +
      '`1000A` are the same code. Leading and trailing whitespace is trimmed.',
  });

const accountNameSchema = z.string().trim().min(1).max(ACCOUNT_NAME_MAX_LENGTH).meta({
  description: 'Display name, e.g. `Operating bank account`.',
});

const accountDescriptionSchema = z.string().trim().max(ACCOUNT_DESCRIPTION_MAX_LENGTH).meta({
  description: 'Optional free text. Send `null` to clear it.',
});

/**
 * An account as the API returns it.
 *
 * Nullable-and-required rather than optional, per the convention plugin-api's
 * `PostedJournal` states: a persisted row either holds a value or holds NULL, and
 * under `exactOptionalPropertyTypes` an absent key is a different type from a
 * null one.
 *
 * `orgId` is absent and should stay absent. Every account the caller can reach
 * belongs to the context's org — `tenantDb` makes any other one unreachable — so
 * the field would carry no information and would be one more place a cross-org id
 * could appear in a response.
 *
 * ## `parentAccountId` is absent on purpose — see the block below
 */
export const accountSchema = z
  .strictObject({
    id: z.uuid(),
    code: accountCodeSchema,
    name: accountNameSchema,
    type: accountTypeSchema,
    normalBalance: normalBalanceSchema,
    description: accountDescriptionSchema.nullable(),
    isActive: z.boolean().meta({
      description:
        'Inactive accounts keep every posting they carry and cannot be selected for new ones. ' +
        'This is the only form of removal available to an account that has been posted to.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ description: 'One account in the org’s chart of accounts.' });

export type Account = z.infer<typeof accountSchema>;

/**
 * ## Why no schema in this file mentions `parentAccountId`
 *
 * `accounts.parent_account_id` exists in the schema from M1 — `0002_ledger` adds
 * it early precisely so that M2 does not have to `ALTER` a table holding every
 * customer's chart of accounts. The column shipping early does not mean the API
 * should accept it, and in M1 it must not.
 *
 * Hierarchy is M2 (ROADMAP, "Explicitly out of M1"), and hierarchy is not one
 * field, it is a set of rules that do not exist yet: whether a parent may be a
 * different `type` from its child, whether a parent is postable or only a rollup,
 * how a subtotal is computed, what happens to children when a parent is
 * deactivated, and how deep the tree may go. Accepting the field now would
 * persist customer data whose meaning is decided later, which inverts the order —
 * M2 would inherit trees built under no rules and have to invent rules that fit
 * them.
 *
 * The absence is enforced rather than documented. Every request schema here is a
 * `strictObject`, so `parentAccountId` (or `parent_account_id`) in a request body
 * is a `validation_failed` naming the key, not a field quietly dropped by a
 * permissive parser. A client that sends it learns that it was not accepted,
 * which is the difference between a deliberate omission and an accident.
 * `test/accounts/schemas.test.ts` pins it.
 *
 * The server writes the column explicitly as `NULL` on insert for the same
 * reason — see `accounts.repository.ts`.
 */

/**
 * `type` and `normalBalance` are both required and independent.
 *
 * Defaulting `normalBalance` from `type` would be right for most accounts and is
 * the reason to *not* do it: the default would be silently wrong for exactly the
 * accounts where the field matters, and a contra account created with the wrong
 * normal balance is not visibly broken — it reports with an inverted sign, which
 * reads as a data problem rather than a setup problem. Making the caller state it
 * costs one field and removes the failure mode.
 */
export const createAccountRequestSchema = z
  .strictObject({
    code: accountCodeSchema,
    name: accountNameSchema,
    type: accountTypeSchema,
    normalBalance: normalBalanceSchema,
    description: accountDescriptionSchema.nullish(),
  })
  .meta({ description: 'Creates one account. Accounts are created active.' });

export type CreateAccountRequest = z.infer<typeof createAccountRequestSchema>;

/**
 * Every field optional; an absent field is left alone and an explicit `null`
 * clears it.
 *
 * `isActive` is deliberately not here. Deactivation is the sanctioned alternative
 * to deleting a posted account, and it is what the delete path's error tells the
 * caller to do, so it is its own operation rather than a flag buried in a patch
 * body — a state change that a report's contents depend on should not be
 * expressible as a side effect of renaming something.
 *
 * `type` and `normalBalance` are accepted here but the service refuses them once
 * the account carries postings. See `updateAccount` for why.
 */
export const updateAccountRequestSchema = z
  .strictObject({
    code: accountCodeSchema.optional(),
    name: accountNameSchema.optional(),
    type: accountTypeSchema.optional(),
    normalBalance: normalBalanceSchema.optional(),
    description: accountDescriptionSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    description:
      'Partial update. An absent field is unchanged; `description: null` clears it. `type` ' +
      'and `normalBalance` are refused once the account has postings.',
  });

export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

/**
 * List filters.
 *
 * `isActive` is a real boolean, not a query-string flag. A shared schema that
 * accepted `'false'` would accept it from a JSON body too, and `'false'` is
 * truthy in every language an integrator might use. Coercing a querystring is the
 * route's job (`z.stringbool()` in OB-023), because the route is the only layer
 * that knows the value arrived as text.
 */
export const listAccountsQuerySchema = z
  .strictObject({
    type: accountTypeSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .meta({
    description: 'Omitting a filter matches every account, active and inactive alike.',
  });

export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

/**
 * An envelope rather than a bare array, for the reason `errorResponseSchema`
 * gives: a top-level object has somewhere to put a later addition. The one this
 * will need is pagination, and adding a `nextCursor` beside `accounts` is a
 * compatible change while wrapping an array that clients already index into is
 * not.
 *
 * M1 returns the whole chart unpaginated. That is a bounded set by nature — a
 * chart of accounts is authored by hand and runs to hundreds of rows, not
 * millions — and inventing a cursor format here would commit every later list
 * endpoint to matching it before there is a second one to compare against.
 */
export const accountListSchema = z
  .strictObject({
    accounts: z.array(accountSchema),
  })
  .meta({
    description:
      'The matching accounts, ordered by `code`. Unpaginated in M1: a chart of accounts is ' +
      'bounded by the org’s own chart.',
  });

export type AccountList = z.infer<typeof accountListSchema>;
