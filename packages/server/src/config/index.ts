/**
 * The config module's public surface — and the only place in the codebase that
 * may read `process.env` (openbooks/no-process-env allows it under
 * src/config/** and nowhere else).
 */
import type { Config } from './config';
import { loadConfig } from './config';

export type {
  BankFeedConfig,
  Config,
  EmailConfig,
  QueueConfig,
  SecretsConfig,
  StorageConfig,
} from './config';
export { loadConfig } from './config';

export type { Env, LogLevel, NodeEnv, ProviderRequirements } from './env';
export { LOG_LEVELS, NODE_ENVS, PROVIDER_REQUIREMENTS } from './env';

export type { ConfigIssue } from './errors';
export { ConfigValidationError, formatConfigIssues } from './errors';

export type {
  BankFeedProviderId,
  EmailProviderId,
  ProviderSelection,
  QueueProviderId,
  SecretsProviderId,
  StorageProviderId,
} from './providers';
export {
  BANK_FEED_PROVIDERS,
  EMAIL_PROVIDERS,
  HOSTED_PROVIDERS,
  QUEUE_PROVIDERS,
  SECRETS_PROVIDERS,
  SELF_HOST_PROVIDERS,
  STORAGE_PROVIDERS,
} from './providers';

export type { Redacted, RedactedConfig } from './redact';
export { REDACTED, redactConfig } from './redact';

export type { ProcessRole } from './role';
export { InvalidRoleError, PROCESS_ROLES, resolveRole } from './role';

let resolved: Config | undefined;

/**
 * The process-wide config, resolved from `process.env` on first call and reused
 * thereafter — spec §3's "resolved once at startup".
 *
 * A function rather than an exported `const` so that importing anything from
 * this module does not validate the environment as a side effect. A const would
 * mean `tsx src/db/codegen.ts` or a unit test crashing on a missing
 * `DATABASE_PASSWORD` merely because something in its import graph mentioned
 * config. Entrypoints call this first; failure is a non-zero exit before
 * anything opens a connection.
 */
export function getConfig(): Config {
  resolved ??= loadConfig(process.env);
  return resolved;
}
