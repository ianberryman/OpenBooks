import type { EmailProvider } from '@openbooks/plugin-api';

import type { Config } from '../config';
import { getConfig } from '../config';
import type { Logger } from '../logging';
import { getLogger } from '../logging';
import { createLogEmailProvider } from './email/log';
import { createSesEmailProvider } from './email/ses';

/**
 * Concrete provider adapters, selected by the configuration (spec §3, D-07).
 *
 * D-07's rule is that the interfaces and the env-driven selection ship early and
 * each adapter ships with its first consumer, because "writing adapters with no
 * consumer would mean writing them untested". OB-040 is the first consumer of one
 * of them: an invite has to reach an address. So this module holds email and
 * nothing else — queue, storage, and secrets still have no consumer, and adding
 * their adapters here on the grounds that the directory now exists would be the
 * exact mistake D-07 names.
 *
 * The selection mirrors `src/config/config.ts`'s: a `switch` over a discriminated
 * union, exhaustive, so a new provider id does not compile until it has an adapter.
 * That is the whole reason `EmailConfig` is a union rather than a bag of optional
 * fields — the adapter is handed a shape whose fields startup already proved.
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

export { createLogEmailProvider } from './email/log';
export { createSesEmailProvider } from './email/ses';
