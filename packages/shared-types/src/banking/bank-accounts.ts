import { z } from 'zod';

import { pageQueryShape, pageSchema } from '../wire';

/**
 * Bank accounts (OB-075, for OB-076; ROADMAP D-41, D-46).
 *
 * ## A bank account is a ledger account plus import metadata
 *
 * D-46, and it is the shape of this whole file. A `bankAccount` names an account
 * that already exists in the chart, and adds the things a *statement* needs that a
 * ledger account has no business knowing: which institution it came from, and what
 * the bank's own file calls it.
 *
 * ## There is no default import mapping here
 *
 * A `defaultImportMappingId` was on this contract and has been taken off it. It
 * reads as a harmless convenience and it is a foreign key in disguise: persisting it
 * points `bank_accounts` at `bank_import_mappings`, which already points back at
 * `bank_accounts`, and that cycle is the one `0005_subledger`'s
 * `org_accounting_settings` header argues against — an `ON DELETE CASCADE` running
 * into a `RESTRICT` pointing the other way. Neither usual escape is open: an
 * unenforced id is a dangling reference by another name, and `ON DELETE SET NULL` is
 * refused on every composite tenant key in this schema, because MySQL requires every
 * column of a SET NULL key to be nullable and `org_id` never is.
 *
 * OB-076 offers the account's **most recently used** mapping instead, which is what
 * a default was standing in for. It needs no field here and no column anywhere:
 * `idx_bank_import_mappings_org_account (org_id, bank_account_id, updated_at)`
 * already answers it, and a mapping the user last reached for is a better guess than
 * one they nominated once and forgot.
 *
 * ## There is no balance here, and there must never be one
 *
 * The balance a user sees on a bank account is the ledger account's balance,
 * computed from journal lines exactly as the trial balance is. D-46 is D-34 applied
 * to a different record: "storing both as peers is how a banking module ends up
 * disagreeing with its own general ledger."
 *
 * The statement's closing balance is not the counter-example. It is a *claim from
 * outside*, and it lives on the import that carried it (`bankStatementImportSchema`)
 * and on the session that tests it (`reconciliationSessionSchema`) — never on the
 * account, because an account with a `balance` field is a field somebody will read
 * instead of the ledger.
 *
 * `strictObject` throughout, so a client that sends what it thinks is a balance is
 * told rather than having it silently dropped.
 *
 * ## The component ids arrived with OB-084's routes
 *
 * `/v1`'s banking surface (OB-084) routes a bank account, so the component ids are
 * here now — added in the same diff as the routes, the sequence `accounts/accounts.ts`
 * argues in full and every milestone since has repeated. The list query carries none
 * (a querystring is emitted as individual `parameters`); see `banking.ts`.
 */

/**
 * Column widths. The inequality runs the safe way for `accounts.ts`'s reason:
 * MySQL's `VARCHAR(n)` counts characters and `String.length` counts UTF-16 code
 * units, so a value these schemas accept cannot be truncated by the column that
 * stores it.
 */
export const BANK_ACCOUNT_NAME_MAX_LENGTH = 255;
export const BANK_INSTITUTION_NAME_MAX_LENGTH = 255;
export const BANK_EXTERNAL_ACCOUNT_ID_MAX_LENGTH = 64;

/**
 * Where a bank account's lines come from (D-41; extended by OB-227, D-126).
 *
 * The enum existed with one member exactly so a live feed could arrive as an added
 * value rather than a new column, and OB-227 lands that: `file` is the user
 * uploading a statement, `stripe_financial_connections` is a live Stripe Financial
 * Connections feed, and `fake` is the deterministic feed the gate exercises in place
 * of a network call (D-102). An account reads `file` until a `bank_feed_connections`
 * row is created for it, which flips it to the connection's source.
 */
export const BANK_FEED_SOURCES = ['file', 'stripe_financial_connections', 'fake'] as const;

export type BankFeedSource = (typeof BANK_FEED_SOURCES)[number];

export const bankFeedSourceSchema = z.enum(BANK_FEED_SOURCES).meta({
  description:
    'How lines reach this account. `file` — the user uploads a statement — is the default. ' +
    '`stripe_financial_connections` is a live feed (OB-227); `fake` is the deterministic feed the ' +
    'gate exercises in place of a network call (D-102). A live source is set when a bank feed is ' +
    'connected and reverts to `file` on disconnect.',
});

const bankAccountNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(BANK_ACCOUNT_NAME_MAX_LENGTH)
  .meta({
    description:
      'What the user calls this account — “Barclays Current”. Distinct from the ledger account’s ' +
      'name on purpose: an org may reconcile two cards against one ledger account, or rename the ' +
      'account in its chart without renaming the thing it uploads statements for.',
  });

const bankInstitutionNameSchema = z.string().trim().min(1).max(BANK_INSTITUTION_NAME_MAX_LENGTH);

/**
 * The identifier the *bank's own file* uses for this account — OFX's `ACCTID`, the
 * account reference a CSV export puts in its header.
 *
 * It exists to answer one question at import time: is this file for this account?
 * Uploading March's current-account statement into the savings account is the
 * ordinary disaster of this feature, and it is silent — every line imports, every
 * line fails to match, and the reconciliation that eventually notices is weeks
 * later. A file whose identifier disagrees with the account's is worth a warning
 * the user can override, which needs somewhere to have recorded the identifier.
 *
 * Deliberately *not* the full account number. This is a matching handle, not a
 * payment instruction — nothing in M4 initiates a payment (the milestone's own
 * out-of-scope list), so there is no reason to hold the digits that would let it.
 */
const bankExternalAccountIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(BANK_EXTERNAL_ACCOUNT_ID_MAX_LENGTH);

/**
 * A bank account as the API returns it.
 *
 * `accountId` is the whole of D-46: it is not a link to somewhere a balance is
 * cached, it is where the balance *is*. A caller wanting the balance reads the
 * ledger account, through the reports it already has.
 */
export const bankAccountSchema = z
  .strictObject({
    id: z.uuid(),
    accountId: z.uuid().meta({
      description:
        'The ledger account this bank account *is* (D-46). Its balance is this bank account’s ' +
        'balance — there is no second figure here, because a banking module that stored its own ' +
        'would eventually disagree with the general ledger it is meant to corroborate.',
    }),
    name: bankAccountNameSchema,
    institutionName: bankInstitutionNameSchema.nullable(),
    externalAccountId: bankExternalAccountIdSchema.nullable().meta({
      description:
        'What the bank’s own file calls this account — OFX’s `ACCTID`. Held so an upload can be ' +
        'checked against the account it is being imported into; not a full account number, because ' +
        'nothing in v1 initiates a payment.',
    }),
    feedSource: bankFeedSourceSchema,
    isActive: z.boolean().meta({
      description:
        'An inactive bank account keeps every line, import and reconciliation it already has and ' +
        'accepts no new ones. Deactivation rather than deletion, for the reason it is deactivation ' +
        'everywhere else: the ledger references this account and nothing referenced by a journal ' +
        'may vanish.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'BankAccount',
    description:
      'A bank account: a ledger account (`accountId`, D-46) plus the import metadata a ' +
      'statement needs. Its balance is the ledger account’s — there is no second figure here.',
  });

export type BankAccount = z.infer<typeof bankAccountSchema>;

/**
 * Registers an existing ledger account as a bank account.
 *
 * `accountId` is required and names an account the org already has. Creating the
 * ledger account as a side effect is the obvious convenience and is refused for
 * D-23's reason: the chart of accounts is the org's, templates are opt-in and
 * unenforced, and a module that invents accounts in it decides the org's chart on
 * its behalf.
 *
 * `isActive` is absent, as it is on every create request in this API — a resource
 * is created active, and deactivation is its own operation.
 */
export const createBankAccountRequestSchema = z
  .strictObject({
    accountId: z.uuid(),
    name: bankAccountNameSchema,
    institutionName: bankInstitutionNameSchema.nullish(),
    externalAccountId: bankExternalAccountIdSchema.nullish(),
  })
  .meta({
    id: 'CreateBankAccountRequest',
    description:
      'Registers an existing ledger account as a bank account. `accountId` names an account the ' +
      'org already has — the chart is the org’s, and a module that invented accounts in it would ' +
      'decide the org’s chart on its behalf (D-23).',
  });

export type CreateBankAccountRequest = z.infer<typeof createBankAccountRequestSchema>;

/**
 * Partial update. An absent field is unchanged; `null` clears a nullable one.
 *
 * `accountId` is not here. Repointing a bank account at a different ledger account
 * would leave every already-cleared line asserting a balance on an account it no
 * longer refers to, and the journals those clearings posted cannot be restated
 * (spec §2.2). The answer to "we pointed it at the wrong account" is a new bank
 * account and a journal moving the balance — `orgs/settings.ts` makes the same
 * argument at greater length for the control accounts.
 *
 * `isActive` is not here either, for `updateAccountRequestSchema`'s reason:
 * deactivation is its own operation, so that it can refuse (an open session,
 * `bank_account_has_open_session`) without a partial update having to.
 */
export const updateBankAccountRequestSchema = z
  .strictObject({
    name: bankAccountNameSchema.optional(),
    institutionName: bankInstitutionNameSchema.nullish(),
    externalAccountId: bankExternalAccountIdSchema.nullish(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .meta({
    id: 'UpdateBankAccountRequest',
    description:
      'Partial update. `accountId` and `isActive` are absent on purpose: repointing at a different ' +
      'ledger account would orphan every cleared line, and deactivation is its own operation so it ' +
      'can refuse an account with an open session (`bank_account_has_open_session`).',
  });

export type UpdateBankAccountRequest = z.infer<typeof updateBankAccountRequestSchema>;

/**
 * `isActive` is a real boolean and not a query-string flag, following
 * `listAccountsQuerySchema`: the shared schema takes booleans and the route
 * coerces, because `'false'` is truthy in every language an integrator might use.
 */
export const listBankAccountsQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListBankAccountsQuery = z.input<typeof listBankAccountsQuerySchema>;

/**
 * Ordered by `(created_at, id)`, the default this API's list endpoints use (D-21).
 * `name` is what a user would sort on and is editable, and a keyset over a mutable
 * column silently drops the rows that moved behind the cursor.
 */
export const bankAccountPageSchema = pageSchema(bankAccountSchema, {
  id: 'BankAccountPage',
  description: 'One page of bank accounts, oldest first by creation.',
});

export type BankAccountPage = z.infer<typeof bankAccountPageSchema>;
