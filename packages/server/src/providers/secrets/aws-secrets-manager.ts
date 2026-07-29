import type { SecretsProvider } from '@openbooks/plugin-api';

import type { SecretsConfig } from '../../config';

/**
 * The hosted `SecretsProvider`, deferred (initiative J). Not implemented: the
 * real adapter calls the AWS Secrets Manager API, which is not something the
 * gate can exercise, so this throws at construction exactly as the `sqs`
 * queue adapter does (`providers/index.ts`'s `selectQueueProvider`) and the
 * `anthropic` extraction adapter does before its own first consumer
 * (`providers/extraction/anthropic.ts`). Self-host runs
 * SECRETS_PROVIDER=local (`./local.ts`, a real encrypted store, not a stub);
 * this adapter lands with the deploy that needs it, as the sqs/anthropic
 * adapters do.
 */
export function createAwsSecretsManagerProvider(
  _secrets: Extract<SecretsConfig, { provider: 'aws-secrets-manager' }>,
): SecretsProvider {
  throw new Error(
    'The aws-secrets-manager secrets adapter is not implemented yet (initiative J). ' +
      'Self-host uses SECRETS_PROVIDER=local; the hosted adapter lands with the deploy ' +
      'that needs it, as the sqs/anthropic adapters do.',
  );
}
