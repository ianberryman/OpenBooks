import type {
  DocumentExtractionProvider,
  EmailProvider,
  InboundMailProvider,
  QueueProvider,
  SecretsProvider,
  StorageProvider,
} from '@openbooks/plugin-api';

import type { Config } from '../config';
import { getConfig } from '../config';
import type { Logger } from '../logging';
import { getLogger } from '../logging';
import { createLogEmailProvider } from './email/log';
import { createSesEmailProvider } from './email/ses';
import { createDocumentExtractionProvider } from './extraction';
import { createInboundMailProvider } from './inbound-mail';
import { InProcessQueue } from './queue/in-process';
import { createSecretsProvider } from './secrets';
import { createStorageProvider } from './storage';

/**
 * Concrete provider adapters, selected by the configuration (spec §3, D-07).
 *
 * D-07's rule is that the interfaces and the env-driven selection ship early and
 * each adapter ships with its first consumer, because "writing adapters with no
 * consumer would mean writing them untested". Two consumers exist now: OB-040's
 * invite needs an address (email), and OB-078's statement import needs a job off the
 * request (queue). So this module holds email and queue and nothing else — storage
 * and secrets still have no consumer, and adding their adapters here on the grounds
 * that the directory now exists would be the exact mistake D-07 names.
 *
 * The selection mirrors `src/config/config.ts`'s: a `switch` over a discriminated
 * union, exhaustive, so a new provider id does not compile until it has an adapter.
 * That is the whole reason `EmailConfig`/`QueueConfig` are unions rather than bags of
 * optional fields — the adapter is handed a shape whose fields startup already proved.
 */
export function selectEmailProvider(config: Config, logger: Logger): EmailProvider {
  const email = config.providers.email;
  switch (email.provider) {
    case 'ses':
      return createSesEmailProvider(email);
    case 'log':
      return createLogEmailProvider(email, logger);
  }
}

/**
 * The queue adapter for this deployment (D-07, D-49).
 *
 * `in-process` is the whole self-host story: no broker, jobs run in the enqueuing
 * process (see `queue/in-process.ts`). `sqs` has no adapter yet and throws when
 * selected, exactly as the hosted bank-feed adapter is absent (D-41) — it ships with
 * the multi-instance worker that is its first and only consumer. The switch is
 * exhaustive so that a third `QueueConfig` member could not be added without an
 * adapter to answer for it.
 */
export function selectQueueProvider(config: Config, logger: Logger): QueueProvider {
  const queue = config.providers.queue;
  switch (queue.provider) {
    case 'in-process':
      return new InProcessQueue(logger);
    case 'sqs':
      throw new Error(
        'The sqs queue adapter is not implemented yet (D-49). Self-host uses ' +
          'QUEUE_PROVIDER=in-process; the hosted adapter lands with the multi-instance worker ' +
          'that consumes it, exactly as the hosted bank-feed adapter does (D-41).',
      );
  }
}

/**
 * Everything this process needs in order to put a working link in someone's inbox.
 *
 * The base URL travels with the provider rather than being read from config at the
 * point the message is built, and the reason is the seam: these two are the entire
 * outbound-mail dependency of `modules/members`, they have to be replaceable
 * together for a test to observe a real send, and a service reaching for
 * `getConfig()` directly would make that impossible — `getConfig()` validates
 * `process.env`, so a suite that never intended to configure a whole process would
 * have to configure one anyway.
 */
export interface OutboundEmail {
  readonly provider: EmailProvider;
  /**
   * Where a failed send is reported.
   *
   * Part of the seam rather than reached through `getLogger()` at the point of
   * failure, and for the same reason as the base URL: `getLogger()` resolves
   * `getConfig()`, so the one code path that must never throw — the catch around a
   * send — would depend on the environment being loadable. It also means the test
   * that watches a send watches its failure log through the same stream.
   */
  readonly logger: Logger;
  /**
   * `APP_BASE_URL`. Absent when the operator has not declared the app's public
   * origin, in which case a link is emitted as a path — see `env.ts` for why the
   * server cannot work it out.
   */
  readonly appBaseUrl?: string;
}

let resolved: OutboundEmail | undefined;

/**
 * The process-wide outbound email dependency, built on first send.
 *
 * A function rather than an exported `const`, for the reason `getConfig()` and
 * `getLogger()` are: importing this module must not validate the environment or
 * construct an AWS client as a side effect of something in an import graph
 * mentioning email. Lazily rather than from an entrypoint, so all three roles (api,
 * worker, migrate) get the same behaviour without any of them having to remember to
 * initialize something they may never use — `migrate` sends no mail and builds no
 * client.
 */
export function outboundEmail(): OutboundEmail {
  // `??=` and not a `const config = getConfig()` above it: an installed value must
  // short-circuit the config read entirely, or the seam below buys nothing.
  resolved ??= fromConfig();
  return resolved;
}

function fromConfig(): OutboundEmail {
  const config = getConfig();
  const logger = getLogger();
  return {
    provider: selectEmailProvider(config, logger),
    logger,
    // Spread rather than an assignment, because exactOptionalPropertyTypes
    // distinguishes an absent key from one holding `undefined`.
    ...(config.appBaseUrl === undefined ? {} : { appBaseUrl: config.appBaseUrl }),
  };
}

/**
 * Installs the outbound email dependency for the rest of the process, or clears it.
 *
 * This exists for hosts, not for services: the OB-040 suites install a `log`
 * adapter writing to a capture stream so that an invite test can read the token out
 * of the message that was really produced (spec §11 rules out mocks — see
 * `email/log.ts`), and M5's module host will need the same seam to hand a module
 * the providers it was given.
 *
 * Deliberately not a general provider registry. There is one provider with one
 * consumer; a registry now would be a shape designed against a single use, which is
 * the risk spec §8 already records for `plugin-api` and there is no reason to
 * repeat it a layer down.
 */
export function setOutboundEmail(value: OutboundEmail | undefined): void {
  resolved = value;
}

/**
 * The process-wide queue dependency, built on first use.
 *
 * The same seam as `outboundEmail`, and for the same reasons: a function rather than
 * an exported `const`, so importing this module does not validate the environment or
 * construct an adapter as a side effect; lazy, so all three roles get the same
 * behaviour without any of them initializing a queue they may never touch. `startImport`
 * reads it to enqueue (OB-078); the worker reads it to register the handler and block.
 *
 * A single accessor rather than a `Providers` bag, because the queue has exactly one
 * consumer so far — a registry now would be the shape spec §8 warns against, built
 * against a single use, which is the risk `setOutboundEmail`'s comment already records.
 */
let resolvedQueue: QueueProvider | undefined;

export function queueProvider(): QueueProvider {
  // `??=` and not a `const config = getConfig()` above it, for `outboundEmail`'s
  // reason: an installed value must short-circuit the config read entirely.
  resolvedQueue ??= selectQueueProvider(getConfig(), getLogger());
  return resolvedQueue;
}

/**
 * Installs the queue for the rest of the process, or clears it.
 *
 * For hosts and tests, not services — the same seam `setOutboundEmail` is: an OB-078
 * suite installs an `InProcessQueue` it also holds a reference to, so it can drive a
 * job to completion through `settled()` and observe the lines land, which is spec
 * §11's "no mocks" applied to the async path. The worker entrypoint installs the
 * selected adapter here so `startImport` and the registered handler share one instance.
 */
export function setQueueProvider(value: QueueProvider | undefined): void {
  resolvedQueue = value;
}

/**
 * The process-wide storage dependency, built on first use.
 *
 * The same seam as `outboundEmail` and `queueProvider`, and for the same reasons: a
 * function rather than an exported `const`, so importing this module does not validate
 * the environment or construct an AWS client as a side effect; lazy, so all three roles
 * (api, worker, migrate) get the same behaviour without any of them building an S3
 * client for a store they never touch — `migrate` keeps no blobs and builds nothing.
 *
 * Its first consumer is invoicing (OB-120): the api reads it to retain a rendered PDF
 * and to store an org logo, and to hand a client a `signedUrl` for either. Selection is
 * config-driven and needs no logger — unlike the queue and email, a storage adapter has
 * no failure it reports out of band; a failed `put`/`get` rejects to its caller.
 *
 * A single accessor rather than a `Providers` bag, for `queueProvider`'s reason: one
 * consumer so far, and a registry now would be the shape spec §8 warns against.
 */
let resolvedStorage: StorageProvider | undefined;

export function storageProvider(): StorageProvider {
  // `??=` and not a `const config = getConfig()` above it, for `outboundEmail`'s
  // reason: an installed value must short-circuit the config read entirely.
  resolvedStorage ??= createStorageProvider(getConfig().providers.storage);
  return resolvedStorage;
}

/**
 * Installs the storage adapter for the rest of the process, or clears it.
 *
 * For hosts and tests, not services — the same seam `setQueueProvider` is. A suite that
 * exercises retained-PDF or logo handling installs a `local` adapter pointed at a temp
 * directory and reads the bytes back through the same `get` the api would, which is spec
 * §11's "no mocks" applied to blob storage.
 */
export function setStorageProvider(value: StorageProvider | undefined): void {
  resolvedStorage = value;
}

/**
 * The process-wide document-extraction dependency, built on first use (initiative
 * O). The same seam as `storageProvider`, and for the same reasons: a function
 * rather than an exported `const`, so importing this module builds nothing; lazy,
 * so `migrate` — which extracts nothing — never constructs an adapter. Its
 * consumer is the extraction job (`DOCUMENT_EXTRACTION_QUEUE`, feature wave):
 * `runAsAutomation` resolves it inside the queue handler, never at request time,
 * because extraction always runs off the request path.
 *
 * A single accessor rather than folded into a `Providers` bag, for `storageProvider`'s
 * reason: one consumer, and a registry now would be the shape spec §8 warns against.
 */
let resolvedDocumentExtraction: DocumentExtractionProvider | undefined;

export function documentExtractionProvider(): DocumentExtractionProvider {
  // `??=` and not a `const config = getConfig()` above it, for `outboundEmail`'s
  // reason: an installed value must short-circuit the config read entirely.
  resolvedDocumentExtraction ??= createDocumentExtractionProvider(
    getConfig().providers.documentExtraction,
  );
  return resolvedDocumentExtraction;
}

/**
 * Installs the document-extraction adapter for the rest of the process, or clears
 * it. For hosts and tests, not services — the same seam `setStorageProvider` is. A
 * suite that exercises the extraction job installs the `deterministic` adapter (or
 * a fixture-backed one) and reads the fields it wrote back through the same
 * `document_captures` row a real job would.
 */
export function setDocumentExtractionProvider(value: DocumentExtractionProvider | undefined): void {
  resolvedDocumentExtraction = value;
}

/**
 * The process-wide inbound-mail dependency, built on first use (initiative O). The
 * same seam as `documentExtractionProvider`: lazy, one consumer — the
 * `POST /v1/bills/inbound/:token` route (feature wave), which resolves the org
 * from the token first and then calls `parse` on the raw webhook.
 */
let resolvedInboundMail: InboundMailProvider | undefined;

export function inboundMailProvider(): InboundMailProvider {
  // `??=` and not a `const config = getConfig()` above it, for `outboundEmail`'s
  // reason: an installed value must short-circuit the config read entirely.
  resolvedInboundMail ??= createInboundMailProvider(getConfig().providers.inboundMail);
  return resolvedInboundMail;
}

/**
 * Installs the inbound-mail adapter for the rest of the process, or clears it. For
 * hosts and tests, not services — the same seam `setDocumentExtractionProvider` is.
 * A suite that exercises the inbound route installs the `dev` adapter and posts a
 * real JSON webhook body at it, rather than mocking `parse`'s return value.
 */
export function setInboundMailProvider(value: InboundMailProvider | undefined): void {
  resolvedInboundMail = value;
}

/**
 * The process-wide secrets dependency, built on first use (initiative J,
 * D-101). The same seam as `storageProvider`, and for the same reasons: a
 * function rather than an exported `const`, so importing this module builds
 * nothing; lazy, so a role that never connects a processor never constructs
 * one. Its first consumer is connecting a payment processor: the service
 * calls `put` once per credential at connect time and `get` wherever a
 * `PaymentProcessorProvider` is constructed for a stored connection (see
 * `providers/payment/`).
 *
 * A single accessor rather than folded into a `Providers` bag, for
 * `storageProvider`'s reason: one consumer, and a registry now would be the
 * shape spec §8 warns against.
 */
let resolvedSecrets: SecretsProvider | undefined;

export function secretsProvider(): SecretsProvider {
  // `??=` and not a `const config = getConfig()` above it, for `outboundEmail`'s
  // reason: an installed value must short-circuit the config read entirely.
  resolvedSecrets ??= createSecretsProvider(getConfig().providers.secrets);
  return resolvedSecrets;
}

/**
 * Installs the secrets adapter for the rest of the process, or clears it. For
 * hosts and tests, not services — the same seam `setStorageProvider` is. A
 * suite that exercises connecting a processor installs a `local` adapter
 * pointed at a throwaway `SECRETS_ENCRYPTION_KEY` and reads a stored key back
 * through the same `get` the real service would, spec §11's "no mocks"
 * applied to a secret store.
 */
export function setSecretsProvider(value: SecretsProvider | undefined): void {
  resolvedSecrets = value;
}

export { InProcessQueue } from './queue/in-process';
export { createLogEmailProvider } from './email/log';
export { createSesEmailProvider } from './email/ses';
export {
  createAnthropicExtractionProvider,
  createDeterministicExtractionProvider,
} from './extraction';
export { createDevInboundMailProvider, createSesInboundMailProvider } from './inbound-mail';
export {
  createAwsSecretsManagerProvider,
  createLocalSecretsProvider,
  createSecretsProvider,
} from './secrets';
export { createStorageProvider } from './storage';
