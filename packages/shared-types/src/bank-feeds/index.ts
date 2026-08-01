/**
 * Live bank feeds (OB-227, ROADMAP D-126…D-131).
 *
 * `bank-feeds.ts` — connecting an org's own Stripe Financial Connections
 * credential to a bank account (D-131), the connection DTO the UI reads back
 * (never carrying the restricted key, D-83), and the sync result the management
 * screen shows.
 *
 * The request/response DTOs carry their `.meta({ id })` now that OB-227's transport
 * routes reach them — an id with no route would publish a `components.schemas` entry
 * nothing can reach (A10). `listBankFeedsQuerySchema` and `bankFeedAccountRefSchema`
 * stay id-less: a querystring emits as `parameters`, and the account ref is inlined
 * inside `BankFeedLinkSession`.
 */

export {
  BANK_FEED_CONNECTION_SOURCES,
  BANK_FEED_CREDENTIAL_SOURCES,
  BANK_FEED_EXTERNAL_ACCOUNT_ID_MAX_LENGTH,
  BANK_FEED_INSTITUTION_MAX_LENGTH,
  bankFeedAccountRefSchema,
  bankFeedConnectionPageSchema,
  bankFeedConnectionSchema,
  bankFeedConnectionSourceSchema,
  bankFeedCredentialSourceSchema,
  bankFeedLinkSessionSchema,
  bankFeedSyncResultSchema,
  connectBankFeedRequestSchema,
  createBankFeedLinkSessionRequestSchema,
  listBankFeedsQuerySchema,
} from './bank-feeds';
export type {
  BankFeedAccountRef,
  BankFeedConnection,
  BankFeedConnectionPage,
  BankFeedConnectionSource,
  BankFeedCredentialSource,
  BankFeedLinkSession,
  BankFeedSyncResult,
  ConnectBankFeedRequest,
  CreateBankFeedLinkSessionRequest,
  ListBankFeedsQuery,
} from './bank-feeds';
