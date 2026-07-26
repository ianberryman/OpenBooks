/**
 * The environment schema and the provider requirement table.
 *
 * Schema keys are the env var names verbatim, not camelCase. That keeps every
 * Zod issue path a literal variable an operator can search for, and it lets the
 * requirement table below be typed as `keyof Env` so a typo in a required
 * variable name is a compile error rather than a check that silently passes.
 * Shaping into the nested config object happens afterwards, in `config.ts`.
 */
import { z } from 'zod';
import type { ConfigIssue } from './errors';
import type { ProviderSelection } from './providers';
import {
  BANK_FEED_PROVIDERS,
  EMAIL_PROVIDERS,
  QUEUE_PROVIDERS,
  SECRETS_PROVIDERS,
  SELF_HOST_PROVIDERS,
  STORAGE_PROVIDERS,
} from './providers';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** pino's levels (OB-009 owns the logger; this is only the level vocabulary). */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MUST_BE_SET = 'must be set';
const PORT_MESSAGE = 'must be a port number between 1 and 65535';

function oneOf<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values, { error: `must be one of ${values.join(', ')}` });
}

function requiredString() {
  return z.string({ error: MUST_BE_SET });
}

function portNumber() {
  return z.coerce
    .number({ error: PORT_MESSAGE })
    .int({ error: PORT_MESSAGE })
    .min(1, { error: PORT_MESSAGE })
    .max(65535, { error: PORT_MESSAGE });
}

export const envSchema = z.object({
  // --- Process ------------------------------------------------------------
  // OPENBOOKS_ROLE is deliberately absent: role.ts already resolves it and
  // owns its own error. Duplicating it here would give two sources of truth
  // for which process this is.
  NODE_ENV: oneOf(NODE_ENVS).default('development'),
  LOG_LEVEL: oneOf(LOG_LEVELS).default('info'),

  // --- HTTP ---------------------------------------------------------------
  // Binds all interfaces by default because the process always runs in a
  // container; the published port is the network boundary, not the bind host.
  HTTP_HOST: requiredString().default('0.0.0.0'),
  HTTP_PORT: portNumber().default(3000),

  // --- Database -----------------------------------------------------------
  // No defaults for host/user/password/name. A wrong-but-plausible default
  // means a process that starts happily against the wrong database, which is
  // strictly worse than refusing to start.
  DATABASE_HOST: requiredString(),
  DATABASE_PORT: portNumber().default(3306),
  DATABASE_USER: requiredString(),
  DATABASE_PASSWORD: requiredString(),
  DATABASE_NAME: requiredString(),
  DATABASE_POOL_SIZE: z.coerce
    .number({ error: 'must be an integer between 1 and 100' })
    .int({ error: 'must be an integer between 1 and 100' })
    .min(1, { error: 'must be an integer between 1 and 100' })
    .max(100, { error: 'must be an integer between 1 and 100' })
    .default(10),

  // DATABASE_USER above is the *application* user (openbooks_app), which holds
  // no DDL rights and no UPDATE/DELETE on the journal tables (spec §12). Schema
  // changes therefore need a second identity. Optional here and required only
  // for OPENBOOKS_ROLE=migrate — see the role-conditional check in loadConfig —
  // because the api and worker roles must never hold DDL credentials at all.
  DATABASE_MIGRATOR_USER: z.string().optional(),
  DATABASE_MIGRATOR_PASSWORD: z.string().optional(),

  // --- Session (spec §5) --------------------------------------------------
  SESSION_SECRET: requiredString().min(32, { error: 'must be at least 32 characters' }),
  // Defaults to on. Spec §5 requires a Secure cookie; plain-HTTP local
  // development is the exception and has to ask for it.
  SESSION_COOKIE_SECURE: z.stringbool({ error: 'must be true or false' }).default(true),
  SESSION_COOKIE_DOMAIN: z.string().optional(),

  // --- Provider selectors (spec §3) ---------------------------------------
  QUEUE_PROVIDER: oneOf(QUEUE_PROVIDERS).default(SELF_HOST_PROVIDERS.QUEUE_PROVIDER),
  STORAGE_PROVIDER: oneOf(STORAGE_PROVIDERS).default(SELF_HOST_PROVIDERS.STORAGE_PROVIDER),
  SECRETS_PROVIDER: oneOf(SECRETS_PROVIDERS).default(SELF_HOST_PROVIDERS.SECRETS_PROVIDER),
  EMAIL_PROVIDER: oneOf(EMAIL_PROVIDERS).default(SELF_HOST_PROVIDERS.EMAIL_PROVIDER),
  BANK_FEED_PROVIDER: oneOf(BANK_FEED_PROVIDERS).default(SELF_HOST_PROVIDERS.BANK_FEED_PROVIDER),

  // --- Provider settings --------------------------------------------------
  // Optional here and required conditionally by PROVIDER_REQUIREMENTS. The
  // schema cannot express "required if a sibling has a given value" without
  // producing exactly the generic error message this ticket exists to avoid.
  AWS_REGION: z.string().optional(),
  SQS_QUEUE_URL: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  STORAGE_LOCAL_PATH: z.string().optional(),
  SECRETS_MANAGER_PREFIX: z.string().optional(),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: portNumber().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Which variables each provider choice needs. One row per (selector, provider);
 * the mapped type makes the table exhaustive, so adding a provider to any list
 * in `providers.ts` fails to compile until its row exists here.
 */
export type ProviderRequirements = {
  readonly [S in keyof ProviderSelection]: {
    readonly [P in ProviderSelection[S]]: readonly (keyof Env)[];
  };
};

export const PROVIDER_REQUIREMENTS: ProviderRequirements = {
  QUEUE_PROVIDER: {
    sqs: ['SQS_QUEUE_URL', 'AWS_REGION'],
    'in-process': [],
  },
  STORAGE_PROVIDER: {
    s3: ['S3_BUCKET', 'AWS_REGION'],
    local: ['STORAGE_LOCAL_PATH'],
  },
  SECRETS_PROVIDER: {
    'aws-secrets-manager': ['SECRETS_MANAGER_PREFIX', 'AWS_REGION'],
    env: [],
  },
  EMAIL_PROVIDER: {
    ses: ['EMAIL_FROM_ADDRESS', 'AWS_REGION'],
    smtp: ['EMAIL_FROM_ADDRESS', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD'],
  },
  BANK_FEED_PROVIDER: {
    // Reads an uploaded file; needs nothing from the environment.
    'csv-ofx': [],
  },
};

function missingFor<S extends keyof ProviderSelection>(
  env: Env,
  selector: S,
  provider: ProviderSelection[S],
): ConfigIssue[] {
  return PROVIDER_REQUIREMENTS[selector][provider]
    .filter((variable) => env[variable] === undefined)
    .map((variable) => ({
      variable,
      message: MUST_BE_SET,
      requiredBy: { selector, provider },
    }));
}

/**
 * The five checks are written out rather than looped because a loop over the
 * selectors loses the correlation between a selector and its own provider
 * union, and recovering it costs a cast. Adding a *provider* still touches only
 * the table above; only a sixth *selector* touches this function.
 */
export function missingProviderVars(env: Env): ConfigIssue[] {
  return [
    ...missingFor(env, 'QUEUE_PROVIDER', env.QUEUE_PROVIDER),
    ...missingFor(env, 'STORAGE_PROVIDER', env.STORAGE_PROVIDER),
    ...missingFor(env, 'SECRETS_PROVIDER', env.SECRETS_PROVIDER),
    ...missingFor(env, 'EMAIL_PROVIDER', env.EMAIL_PROVIDER),
    ...missingFor(env, 'BANK_FEED_PROVIDER', env.BANK_FEED_PROVIDER),
  ];
}

export function schemaIssues(error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    variable: typeof issue.path[0] === 'string' ? issue.path[0] : '<unknown>',
    message: issue.message,
  }));
}

/**
 * An env var set to an empty (or whitespace-only) string means "unset". Compose
 * files, CI matrices, and ECS task definitions all produce empty strings for
 * variables nobody filled in, and treating those as present would defeat every
 * check below. Values are not trimmed — a secret's leading space is the
 * secret's business.
 */
export function normalizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') normalized[key] = value;
  }
  return normalized;
}
