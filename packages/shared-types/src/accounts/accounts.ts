import { z } from 'zod';

import { pageQueryShape, pageSchema } from '../wire';

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
 * ## The `id`s, and the rule that governs them
 *
 * `jsonSchemaTransformObject`, registered in `src/transport/openapi.ts`, copies
 * *every* schema carrying an `id` out of zod's global registry into
 * `components.schemas` — the whole registry, not the subset some route
 * references (`fastify-type-provider-zod`'s `copyRegistry` iterates `_idmap`).
 * `.meta({ id })` executes at module evaluation, and this module is evaluated in
 * the API process as soon as anything imports `@openbooks/shared-types`, which
 * `src/modules/idempotency/response.ts` already does.
 *
 * So an `id` is not free: each one adds two components — `Account` and
 * `AccountInput`, one per io direction — whether or not any route references the
 * schema, and A10 makes drift in `openapi.json` a build failure. OB-018 therefore
 * left them off and OB-023 added them in the same diff as the routes that use
 * them.
 *
 * The rule that follows, for anything added here later: **an `id` goes on a body
 * or response schema that a route references, and on nothing else.** In
 * particular `listAccountsQuerySchema` has none and must not gain one — a
 * querystring is emitted as individual `parameters`, so a component for it would
 * be referenced by nothing.
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

/**
 * How many generations a chart of accounts may span, root included (OB-035).
 *
 * Six, and the number is chosen from what a chart is *for* rather than from what
 * the walk can afford. The deepest arrangement an accountant asks for is roughly
 * `Assets → Current assets → Cash and equivalents → Bank accounts → Operating
 * account`, which is five; the sixth exists so an org that also groups by
 * location or entity is not the exception.
 *
 * Beyond that, a chart is being used to carry a second axis — department,
 * project, location — and a code that encodes two things is one that cannot be
 * reported on by either. Dimensions are that axis (OB-033) and they slice every
 * report without multiplying the chart, so the bound is not only an arbitrary
 * stop: it is the boundary at which the right tool is a different one.
 *
 * It is also what makes the cycle check terminate. The ancestor walk stops after
 * this many reads whether or not it has found a root, so the bound and the walk's
 * cost are the same number — see `resolveAssignableParent` in
 * `src/modules/accounts/hierarchy.ts`.
 */
export const ACCOUNT_MAX_DEPTH = 6;

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

const parentAccountIdSchema = z.uuid().meta({
  description:
    'The account this one rolls up into, or `null` for a top-level account. A parent must ' +
    'share this account’s `type`, must not be this account or any of its descendants, and the ' +
    `resulting tree may be at most ${String(ACCOUNT_MAX_DEPTH)} generations deep. An unknown ` +
    'or another organization’s id is a `not_found`, not a validation failure.',
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
 * ## `parentAccountId` is here, and the rules that govern it are not — see below
 */
export const accountSchema = z
  .strictObject({
    id: z.uuid(),
    code: accountCodeSchema,
    name: accountNameSchema,
    type: accountTypeSchema,
    normalBalance: normalBalanceSchema,
    parentAccountId: parentAccountIdSchema.nullable(),
    description: accountDescriptionSchema.nullable(),
    isActive: z.boolean().meta({
      description:
        'Inactive accounts keep every posting they carry and cannot be selected for new ones. ' +
        'This is the only form of removal available to an account that has been posted to.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Account', description: 'One account in the org’s chart of accounts.' });

export type Account = z.infer<typeof accountSchema>;

/**
 * ## What a schema can say about `parentAccountId`, and what it cannot
 *
 * M1 refused the field outright because hierarchy was a set of rules that did not
 * exist. OB-035 wrote them, so the field is accepted — but only its *shape* is
 * expressible here, and the distinction is worth being precise about because
 * three of the four rules are invisible in `openapi.json`.
 *
 * A schema can say that the value is a UUID or `null`. It cannot say that the
 * parent exists, that it belongs to the caller's org, that it shares the child's
 * `type`, that it is not a descendant of the child, or that the resulting tree
 * fits inside `ACCOUNT_MAX_DEPTH`. Every one of those is a statement about rows,
 * so every one of them lives in `accounts.service.ts` — which is also where it
 * has to live for the reason `input.ts` gives: an MCP tool (M5) and the workflow
 * engine (M6) reach the same service with no schema in front of them.
 *
 * The one thing this file does still enforce by absence is `orgId`: a parent is
 * named by id alone, and `tenantDb` decides which org that id is resolved in, so
 * there is no field here through which another org's tree could be joined.
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
    parentAccountId: parentAccountIdSchema.nullish(),
    description: accountDescriptionSchema.nullish(),
  })
  .meta({
    id: 'CreateAccountRequest',
    description:
      'Creates one account. Accounts are created active, and top-level unless a ' +
      '`parentAccountId` is given.',
  });

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
 *
 * ## `code` is absent, and its absence is the enforcement (D-27)
 *
 * An account's code is immutable once created. Two arguments arrive at that, and
 * the mechanical one is the one that forced the decision: the chart is ordered by
 * code, keyset pagination orders by the column it sorts on, and a keyset over a
 * *mutable* column silently drops rows — rename an account and it moves behind a
 * cursor that has already passed it, so it appears on no page at all. That is
 * exactly the failure D-21 chose keyset to eliminate, reached through a mutable
 * sort key instead of through `OFFSET`.
 *
 * The accounting argument is what makes it right rather than merely convenient. A
 * code is not a label, it is the reference other things cite — a journal, an
 * export, a filed schedule, a bookkeeper's memory. Renaming `4000` from "Sales"
 * to "Consulting income" changes what an account is called; renumbering `4000` to
 * `4100` is a different account wearing the old one's history.
 *
 * Unlike `type` it is refused from creation rather than from first posting,
 * because it does not need the softer rule: an account with no postings deletes
 * outright, so a typo costs one call to fix and leaves nothing behind. `name` and
 * `description` stay mutable — those are labels and nothing cites them.
 *
 * Absent rather than accepted-and-ignored: this is a `strictObject`, so `code` in
 * a patch body is a `validation_failed` naming the field. A client that sends it
 * learns it was refused, which is what a silent drop cannot tell them — the same
 * construction M1 used for `parentAccountId`, for the same reason.
 */
export const updateAccountRequestSchema = z
  .strictObject({
    name: accountNameSchema.optional(),
    type: accountTypeSchema.optional(),
    normalBalance: normalBalanceSchema.optional(),
    parentAccountId: parentAccountIdSchema.nullish(),
    description: accountDescriptionSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateAccountRequest',
    description:
      'Partial update. An absent field is unchanged; `description: null` clears it and ' +
      '`parentAccountId: null` makes the account top-level. `code` is immutable and is not ' +
      'accepted. `type` and `normalBalance` are refused once the account has postings.',
  });

export type UpdateAccountRequest = z.infer<typeof updateAccountRequestSchema>;

/**
 * List filters, plus the pagination shared by every list endpoint (D-21).
 *
 * `isActive` is a real boolean, not a query-string flag. A shared schema that
 * accepted `'false'` would accept it from a JSON body too, and `'false'` is
 * truthy in every language an integrator might use. Coercing a querystring is the
 * route's job (`z.stringbool()` in OB-023), because the route is the only layer
 * that knows the value arrived as text.
 *
 * The pagination fields are spread from `pageQueryShape` rather than restated, so
 * the six later lists cannot end up with `perPage`, `pageSize`, and `limit`
 * meaning the same thing.
 */
export const listAccountsQuerySchema = z
  .strictObject({
    ...pageQueryShape,
    type: accountTypeSchema.optional(),
    isActive: z.boolean().optional(),
  })
  .meta({
    description: 'Omitting a filter matches every account, active and inactive alike.',
  });

/**
 * The *input* type, not `z.infer`. `limit` carries a `.default()`, so the parsed
 * output has it and a caller does not — and under `exactOptionalPropertyTypes`
 * those are two different types. Every caller of `listAccounts` supplies the
 * input side.
 */
export type ListAccountsQuery = z.input<typeof listAccountsQuerySchema>;

/**
 * ## Why the chart of accounts is paginated, and why it is code-ordered again
 *
 * M1 returned the whole chart under an `accounts` key and said so: a chart is
 * authored by hand and bounded by the org's own chart, and inventing a cursor
 * format for it alone would have committed every later list endpoint to matching
 * it before there was a second one to compare against. There are now four more
 * (D-21), so the format is decided once and this list takes it too — an endpoint
 * exempted from the convention is the one a client writes a second paging loop
 * for.
 *
 * OB-031 paginated it over `(created_at, id)` rather than `code`, because a
 * keyset ordering has to be immutable and `code` was editable. That was the wrong
 * half of the trade to give up — a chart of accounts read in creation order is
 * not a chart of accounts, it is a log of when someone typed each row — and D-27
 * made `code` immutable instead. The ordering is now `(code, id)`, which is what
 * an accountant expects and what OB-048's screen needs.
 *
 * `id` is carried as a second column even though `uq_accounts_org_code` already
 * makes `code` unique within an org. It costs nothing, it keeps every ordering in
 * the system a pair, and it means the ordering does not quietly stop being total
 * if that unique key is ever relaxed.
 */
export const accountPageSchema = pageSchema(accountSchema, {
  id: 'AccountPage',
  description:
    'One page of the org’s chart of accounts, ordered by `code`. Comparison follows the ' +
    'column’s `utf8mb4_0900_ai_ci` collation, so it is case-insensitive and textual — `1100` ' +
    'sorts before `900`. Codes are immutable, which is what makes a cursor into this list ' +
    'stable while accounts are being created and edited.',
});

export type AccountPage = z.infer<typeof accountPageSchema>;
