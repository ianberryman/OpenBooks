import { z } from 'zod';

import { pageQueryShape, pageSchema } from '../wire';

/**
 * Live bank feeds (OB-227, ROADMAP D-126…D-131).
 *
 * An org connects its own Stripe Financial Connections credential to a bank
 * account, and a daily job pulls transactions into the existing
 * `bank_statement_lines` → match → reconcile pipeline. This file holds the
 * connection an org's admin sets up and the sync result the management screen
 * reads back.
 *
 * ## The `.meta({ id })` land with the routes
 *
 * OB-227's transport now routes these, so the request/response DTOs carry their
 * component ids (`ConnectBankFeedRequest`, `BankFeedConnection`, … ) in the same diff
 * that reaches them — an `id` with no route would publish a `components.schemas` entry
 * nothing can reach and A10 would fail the build. `listBankFeedsQuerySchema` stays
 * id-less (a querystring emits as `parameters`), as does `bankFeedAccountRefSchema`
 * (inlined inside `BankFeedLinkSession`).
 *
 * ## The request carries a key; the response never does
 *
 * `connectBankFeedRequestSchema` carries `restrictedKey`; `bankFeedConnectionSchema`
 * — the DTO returned to the UI — does not, and never will. The key is inbound-only:
 * it is handed to `SecretsProvider.put` (D-101) and the connection row keeps only
 * the name it stored it under (`secret_ref`), the same split
 * `connectProcessorRequestSchema` keeps. v1 is bring-your-own only (D-131): the org
 * supplies its own Stripe restricted key and Stripe bills the org directly.
 */

/**
 * Which live-feed backend a connection talks to (D-126). A subset of
 * `banking`'s `BANK_FEED_SOURCES` — `file` is the absence of a live feed, never a
 * connection. `fake` is a real, deterministic implementation the gate exercises in
 * place of a network call (D-102), not a placeholder value.
 */
export const BANK_FEED_CONNECTION_SOURCES = ['stripe_financial_connections', 'fake'] as const;

export type BankFeedConnectionSource = (typeof BANK_FEED_CONNECTION_SOURCES)[number];

export const bankFeedConnectionSourceSchema = z.enum(BANK_FEED_CONNECTION_SOURCES).meta({
  description:
    'Which live feed this connection talks to. `stripe_financial_connections` is a live Stripe ' +
    'Financial Connections feed; `fake` is the deterministic feed the gate exercises in place of a ' +
    'network call (D-102), not a placeholder value.',
});

/**
 * How the credential the feed authenticates with was supplied (D-131). v1 writes
 * only `bring_your_own` — the org's own Stripe restricted key, billed to the org.
 * `managed` (OpenBooks' own platform key, re-metered to the org) is the deferred
 * model; the value exists so it drops in later without a schema change.
 */
export const BANK_FEED_CREDENTIAL_SOURCES = ['bring_your_own', 'managed'] as const;

export type BankFeedCredentialSource = (typeof BANK_FEED_CREDENTIAL_SOURCES)[number];

export const bankFeedCredentialSourceSchema = z.enum(BANK_FEED_CREDENTIAL_SOURCES).meta({
  description:
    'How the credential was supplied. `bring_your_own` — the org’s own Stripe restricted key, ' +
    'billed to the org — is the only value in v1 (D-131). `managed` is reserved for the deferred ' +
    'model where OpenBooks supplies the key and re-meters the cost.',
});

/**
 * Column widths. The inequality runs the safe way for `accounts.ts`'s reason:
 * MySQL's `VARCHAR(n)` counts characters and `String.length` counts UTF-16 code
 * units, so a value these schemas accept cannot be truncated by the column that
 * stores it — see `0021_bank_feeds`.
 */
export const BANK_FEED_EXTERNAL_ACCOUNT_ID_MAX_LENGTH = 255;
export const BANK_FEED_INSTITUTION_MAX_LENGTH = 255;

const bankFeedExternalAccountIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(BANK_FEED_EXTERNAL_ACCOUNT_ID_MAX_LENGTH);

const bankFeedInstitutionSchema = z.string().trim().min(1).max(BANK_FEED_INSTITUTION_MAX_LENGTH);

/**
 * The restricted key the feed authenticates with. Inbound-only — stored through
 * the secrets provider (D-101) and never echoed by any response (D-83). No `.max`:
 * a provider's key length is the provider's business, and this is never compared to
 * a column width because only its handle is stored, never the value.
 */
const bankFeedRestrictedKeySchema = z
  .string()
  .trim()
  .min(1)
  .meta({
    description:
      'The provider’s restricted API key (Stripe Financial Connections scope). Inbound-only — ' +
      'stored through the secrets provider (D-101) and never echoed by any response (D-83).',
  });

/**
 * One account the connected credential can pull, surfaced by the link/setup flow
 * so a human picks which linked account the connection feeds (D-131). Mirrors the
 * provider boundary's `BankFeedAccountRef`.
 */
export const bankFeedAccountRefSchema = z.strictObject({
  externalAccountId: bankFeedExternalAccountIdSchema,
  institution: bankFeedInstitutionSchema.nullable(),
  displayName: z.string(),
  category: z
    .string()
    .nullable()
    .meta({
      description:
        'The provider’s own classification — Stripe FC reports `cash` for a bank account, `credit` ' +
        'for a card. Advisory in v1, which feeds asset accounts only (D-130).',
    }),
});

export type BankFeedAccountRef = z.infer<typeof bankFeedAccountRefSchema>;

/**
 * Opens a provider link session so the browser can run the credential's own
 * account-linking flow, and returns the accounts it can already pull. For the
 * `fake` feed both are deterministic; for Stripe FC `clientSecret` is the Financial
 * Connections session secret the client runs Stripe.js against (a manual-sandbox
 * path, D-102). `restrictedKey` is inbound-only.
 */
export const createBankFeedLinkSessionRequestSchema = z
  .strictObject({
    feedSource: bankFeedConnectionSourceSchema,
    restrictedKey: bankFeedRestrictedKeySchema,
  })
  .meta({
    id: 'CreateBankFeedLinkSessionRequest',
    description:
      'Opens a provider link session and returns the accounts the credential can already pull. ' +
      '`restrictedKey` is inbound-only (D-83).',
  });

export type CreateBankFeedLinkSessionRequest = z.infer<
  typeof createBankFeedLinkSessionRequestSchema
>;

export const bankFeedLinkSessionSchema = z
  .strictObject({
    clientSecret: z.string().meta({
      description:
        'The provider session secret the browser runs its linking flow against. Deterministic for ' +
        'the `fake` feed; the Stripe FC session secret otherwise.',
    }),
    linkedAccounts: z.array(bankFeedAccountRefSchema).meta({
      description: 'Accounts the credential can already pull — the connect step’s picker.',
    }),
  })
  .meta({
    id: 'BankFeedLinkSession',
    description:
      'A provider link session: the secret the browser runs the linking flow against and the ' +
      'accounts the credential can already pull.',
  });

export type BankFeedLinkSession = z.infer<typeof bankFeedLinkSessionSchema>;

/**
 * Connects a live feed to an existing bank account. `bankAccountId` names a
 * `bank_accounts` row the org already has (D-46); `externalAccountId` is the linked
 * account chosen from the link session. Connecting flips the bank account's
 * `feedSource` to this connection's source; there is one live feed per bank account.
 *
 * `restrictedKey` is inbound-only and never appears in any response (D-83).
 */
export const connectBankFeedRequestSchema = z
  .strictObject({
    bankAccountId: z.uuid(),
    feedSource: bankFeedConnectionSourceSchema,
    restrictedKey: bankFeedRestrictedKeySchema,
    externalAccountId: bankFeedExternalAccountIdSchema,
    institution: bankFeedInstitutionSchema.nullish(),
  })
  .meta({
    id: 'ConnectBankFeedRequest',
    description:
      'Connects a live feed to an existing bank account (D-126). `restrictedKey` is inbound-only ' +
      'and never appears in any response (D-83); connecting flips the bank account to this feed ' +
      'source, and there is one live feed per bank account.',
  });

export type ConnectBankFeedRequest = z.infer<typeof connectBankFeedRequestSchema>;

/**
 * A live-feed connection as the API returns it — never carrying `restrictedKey`.
 * See this file's header for why there is no with-secret counterpart: OpenBooks
 * never minted the value, so there is no one response that gets to show it once.
 */
export const bankFeedConnectionSchema = z
  .strictObject({
    id: z.uuid(),
    bankAccountId: z.uuid(),
    feedSource: bankFeedConnectionSourceSchema,
    credentialSource: bankFeedCredentialSourceSchema,
    externalAccountId: z.string(),
    institution: z.string().nullable(),
    isActive: z.boolean().meta({
      description:
        'An inactive connection stops the daily sync from pulling and keeps every line it already ' +
        'imported. Disconnecting is deactivation, not deletion, and reverts the bank account to ' +
        '`file`.',
    }),
    lastSyncedAt: z.iso.datetime().nullable().meta({
      description: 'When the daily sync last committed against this connection.',
    }),
    lastSyncError: z.string().nullable().meta({
      description: 'The last sync failure, if the most recent run did not complete; advisory.',
    }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'BankFeedConnection',
    description:
      'A live-feed connection as the API returns it — never carrying `restrictedKey` (D-83).',
  });

export type BankFeedConnection = z.infer<typeof bankFeedConnectionSchema>;

/**
 * `isActive` is a real boolean and not a query-string flag, following
 * `listBankAccountsQuerySchema`: the shared schema takes booleans and the route
 * coerces, because `'false'` is truthy in every language an integrator might use.
 */
export const listBankFeedsQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
});

export type ListBankFeedsQuery = z.input<typeof listBankFeedsQuerySchema>;

/**
 * One page of connections. Carries its own `id` now that OB-227's routes reach it:
 * `listBankFeeds` publishes `BankFeedConnectionPage` as a `components.schemas` entry
 * the operation references, so the component and the operation land together and A10
 * stays satisfied. The `{ items, nextCursor }` shape is `pageSchema`'s own (D-21).
 */
export const bankFeedConnectionPageSchema = pageSchema(bankFeedConnectionSchema, {
  id: 'BankFeedConnectionPage',
  description: 'One page of live-feed connections, oldest first by creation.',
});

export type BankFeedConnectionPage = z.infer<typeof bankFeedConnectionPageSchema>;

/**
 * The outcome of one sync run — what the manual trigger returns and what the daily
 * sweep logs per connection. `linesImported`/`linesDuplicate` come straight from
 * the fingerprint dedup the CSV path already uses (D-127): a re-synced overlap is
 * `linesDuplicate`, never a double-post. `cursor` is the pull cursor as advanced by
 * this run (D-128).
 */
export const bankFeedSyncResultSchema = z
  .strictObject({
    connectionId: z.uuid(),
    linesImported: z.number().int().nonnegative(),
    linesDuplicate: z.number().int().nonnegative(),
    cursor: z.string().nullable(),
    syncedAt: z.iso.datetime(),
  })
  .meta({
    id: 'BankFeedSyncResult',
    description:
      'The outcome of one sync run. `linesDuplicate` is a re-synced overlap collapsed by the ' +
      'fingerprint dedup (D-127), never a double-post.',
  });

export type BankFeedSyncResult = z.infer<typeof bankFeedSyncResultSchema>;
