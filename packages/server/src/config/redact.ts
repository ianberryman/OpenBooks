/**
 * A safe-to-log view of the config.
 *
 * Spec §12 puts structured logging in place from Phase 0, and a config object
 * holding a DB password and a session secret will eventually be handed to a
 * logger — at boot, in an error report, or by a debugging `logger.info({ config })`.
 * Better that the safe representation exists than that the discipline holds.
 *
 * Redaction keys off the field *name* at any depth rather than a list of paths,
 * so a secret added to the config later is redacted by virtue of being called a
 * secret. The type and the runtime walk are driven by the same field list, so a
 * redacted value never types as `string`.
 */
import type { Config } from './config';

export const REDACTED = '[redacted]';

const SECRET_FIELD_NAMES = ['password', 'secret'] as const;
type SecretField = (typeof SECRET_FIELD_NAMES)[number];

const SECRET_FIELDS: ReadonlySet<string> = new Set<string>(SECRET_FIELD_NAMES);

export type Redacted<T> = T extends string | number | boolean | null | undefined
  ? T
  : { readonly [K in keyof T]: K extends SecretField ? typeof REDACTED : Redacted<T[K]> };

export type RedactedConfig = Redacted<Config>;

function redactValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return (value as readonly unknown[]).map(redactValue);

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SECRET_FIELDS.has(key) ? REDACTED : redactValue(nested);
  }
  return result;
}

/**
 * The cast is the one place the name-keyed runtime walk and its type-level twin
 * are asserted to agree; both read `SECRET_FIELD_NAMES`.
 */
export function redactConfig(config: Config): RedactedConfig {
  return redactValue(config) as RedactedConfig;
}
