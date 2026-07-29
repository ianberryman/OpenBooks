import type { SecretsProvider } from '@openbooks/plugin-api';

import type { SecretsConfig } from '../../config';

import { createAwsSecretsManagerProvider } from './aws-secrets-manager';
import { createLocalSecretsProvider } from './local';

/**
 * The secrets adapter for this deployment (D-07, D-101), selected by
 * configuration.
 *
 * The switch mirrors `createStorageProvider`/`createDocumentExtractionProvider`:
 * exhaustive over the `SecretsConfig` discriminated union, so a new provider id
 * does not compile until it has an adapter to answer for it. `local` is the
 * self-host story (encrypted-at-rest in the `secrets` table, see `./local.ts`);
 * `aws-secrets-manager` is the hosted one and a documented deferral (see
 * `./aws-secrets-manager.ts`). Both ship now because both have a consumer now
 * — connecting a payment processor (initiative J) is the first thing that ever
 * calls `SecretsProvider.put`.
 */
export function createSecretsProvider(secrets: SecretsConfig): SecretsProvider {
  switch (secrets.provider) {
    case 'local':
      return createLocalSecretsProvider(secrets);
    case 'aws-secrets-manager':
      return createAwsSecretsManagerProvider(secrets);
  }
}

export { createAwsSecretsManagerProvider } from './aws-secrets-manager';
export { createLocalSecretsProvider } from './local';
