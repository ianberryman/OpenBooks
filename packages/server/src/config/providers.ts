/**
 * Provider selection vocabulary (spec §3).
 *
 * Spec §3 requires every external dependency to sit behind an interface with a
 * hosted and a self-host implementation. The interfaces themselves belong to
 * `@openbooks/plugin-api` (OB-002) and the adapters land with their first
 * consumer (D-07) — this module owns only the *names*, so config can validate a
 * choice without depending on the contract package or on any adapter.
 *
 * Each selector's first value is the hosted one and the second the self-host
 * one, paired in `HOSTED_PROVIDERS` / `SELF_HOST_PROVIDERS` below.
 */
export const QUEUE_PROVIDERS = ['sqs', 'in-process'] as const;
export type QueueProviderId = (typeof QUEUE_PROVIDERS)[number];

export const STORAGE_PROVIDERS = ['s3', 'local'] as const;
export type StorageProviderId = (typeof STORAGE_PROVIDERS)[number];

export const SECRETS_PROVIDERS = ['aws-secrets-manager', 'env'] as const;
export type SecretsProviderId = (typeof SECRETS_PROVIDERS)[number];

/**
 * `smtp` was the self-host value until OB-040 and is deliberately gone.
 *
 * D-07 ships an adapter with its first consumer, and the consumer that arrived is
 * the invite email. Two adapters were written for it — `ses` and `log` — and no
 * SMTP client was, so leaving `smtp` selectable would have left one value in this
 * union that validates at startup, names its four required variables, and then
 * throws on the first invite anyone sends. A selector value with no adapter behind
 * it is worse than a missing feature: it fails at the moment a user is waiting for
 * mail rather than at the moment an operator is reading configuration.
 *
 * `log` is a real adapter, not a stub: it writes the whole message to the
 * structured log, which is what a self-host deployment with no relay needs in
 * order to hand someone their invite link at all. An SMTP adapter is a value plus
 * a requirement row when someone writes one.
 */
export const EMAIL_PROVIDERS = ['ses', 'log'] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number];

/**
 * Bank feeds have one implementation in both deployments: spec §3 rules out
 * aggregators for v1, so hosted and self-host both parse uploaded CSV/OFX. The
 * selector exists anyway so that adding an aggregator later is a new value
 * rather than a new mechanism. Bank feeds themselves are M4.
 */
export const BANK_FEED_PROVIDERS = ['csv-ofx'] as const;
export type BankFeedProviderId = (typeof BANK_FEED_PROVIDERS)[number];

/**
 * Document extraction (initiative O, OB-185…191). `deterministic` is the
 * self-host default and a real, testable parser (`key: value` / `line:` text, see
 * `providers/extraction/deterministic.ts`) — not a stub, for `log`'s reason above:
 * a self-host deployment with no LLM budget still needs a working extraction path
 * for the E2E and for a real operator to exercise. `anthropic` is the hosted
 * adapter and a documented DEFERRAL: it throws "not implemented" at construction,
 * exactly like the `sqs` queue adapter, because a live LLM call is not something
 * the gate can exercise yet.
 */
export const DOCUMENT_EXTRACTION_PROVIDERS = ['anthropic', 'deterministic'] as const;
export type DocumentExtractionProviderId = (typeof DOCUMENT_EXTRACTION_PROVIDERS)[number];

/**
 * Inbound mail (initiative O, OB-185…191). `dev` parses the JSON webhook body a
 * local test harness posts, with no signature verification — there is no real
 * mail receiver in front of a self-host deployment to spoof. `ses-inbound` is the
 * hosted adapter and a documented DEFERRAL, throwing exactly as `anthropic` does:
 * real MX records and SES receipt rules are out of scope this wave.
 */
export const INBOUND_MAIL_PROVIDERS = ['ses-inbound', 'dev'] as const;
export type InboundMailProviderId = (typeof INBOUND_MAIL_PROVIDERS)[number];

/** The seven selector variables, keyed by env var name. */
export interface ProviderSelection {
  readonly QUEUE_PROVIDER: QueueProviderId;
  readonly STORAGE_PROVIDER: StorageProviderId;
  readonly SECRETS_PROVIDER: SecretsProviderId;
  readonly EMAIL_PROVIDER: EmailProviderId;
  readonly BANK_FEED_PROVIDER: BankFeedProviderId;
  readonly EXTRACTION_PROVIDER: DocumentExtractionProviderId;
  readonly INBOUND_MAIL_PROVIDER: InboundMailProviderId;
}

/**
 * The self-host set is the schema default: the distributed artifact is the
 * Compose stack, and a deployment that says nothing about providers is a
 * self-host one. A hosted deploy states all seven explicitly in its task
 * definition rather than inheriting them.
 */
export const SELF_HOST_PROVIDERS: ProviderSelection = {
  QUEUE_PROVIDER: 'in-process',
  STORAGE_PROVIDER: 'local',
  SECRETS_PROVIDER: 'env',
  EMAIL_PROVIDER: 'log',
  BANK_FEED_PROVIDER: 'csv-ofx',
  EXTRACTION_PROVIDER: 'deterministic',
  INBOUND_MAIL_PROVIDER: 'dev',
};

export const HOSTED_PROVIDERS: ProviderSelection = {
  QUEUE_PROVIDER: 'sqs',
  STORAGE_PROVIDER: 's3',
  SECRETS_PROVIDER: 'aws-secrets-manager',
  EMAIL_PROVIDER: 'ses',
  BANK_FEED_PROVIDER: 'csv-ofx',
  EXTRACTION_PROVIDER: 'anthropic',
  INBOUND_MAIL_PROVIDER: 'ses-inbound',
};
