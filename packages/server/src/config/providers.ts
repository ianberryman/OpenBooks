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

export const EMAIL_PROVIDERS = ['ses', 'smtp'] as const;
export type EmailProviderId = (typeof EMAIL_PROVIDERS)[number];

/**
 * Bank feeds have one implementation in both deployments: spec §3 rules out
 * aggregators for v1, so hosted and self-host both parse uploaded CSV/OFX. The
 * selector exists anyway so that adding an aggregator later is a new value
 * rather than a new mechanism. Bank feeds themselves are M4.
 */
export const BANK_FEED_PROVIDERS = ['csv-ofx'] as const;
export type BankFeedProviderId = (typeof BANK_FEED_PROVIDERS)[number];

/** The five selector variables, keyed by env var name. */
export interface ProviderSelection {
  readonly QUEUE_PROVIDER: QueueProviderId;
  readonly STORAGE_PROVIDER: StorageProviderId;
  readonly SECRETS_PROVIDER: SecretsProviderId;
  readonly EMAIL_PROVIDER: EmailProviderId;
  readonly BANK_FEED_PROVIDER: BankFeedProviderId;
}

/**
 * The self-host set is the schema default: the distributed artifact is the
 * Compose stack, and a deployment that says nothing about providers is a
 * self-host one. A hosted deploy states all five explicitly in its task
 * definition rather than inheriting them.
 */
export const SELF_HOST_PROVIDERS: ProviderSelection = {
  QUEUE_PROVIDER: 'in-process',
  STORAGE_PROVIDER: 'local',
  SECRETS_PROVIDER: 'env',
  EMAIL_PROVIDER: 'smtp',
  BANK_FEED_PROVIDER: 'csv-ofx',
};

export const HOSTED_PROVIDERS: ProviderSelection = {
  QUEUE_PROVIDER: 'sqs',
  STORAGE_PROVIDER: 's3',
  SECRETS_PROVIDER: 'aws-secrets-manager',
  EMAIL_PROVIDER: 'ses',
  BANK_FEED_PROVIDER: 'csv-ofx',
};
