/**
 * The resolved configuration object and the single function that produces it.
 *
 * Everything downstream reads this shape and never the environment (enforced by
 * openbooks/no-process-env), so this file is where an unvalidated string stops
 * being a string and becomes a typed value.
 *
 * Each provider is a discriminated union rather than a bag of optional fields.
 * The point of the requirement table is that a provider's variables are known
 * present once validation passes; expressing that as `sqs` carrying a
 * non-optional `queueUrl` hands the guarantee to consumers instead of making
 * every call site re-check what startup already proved.
 */
import type { Env, LogLevel, NodeEnv } from './env';
import {
  corsIssues,
  envSchema,
  missingProviderVars,
  normalizeEnv,
  parseOriginList,
  schemaIssues,
} from './env';
import type { ConfigIssue } from './errors';
import { ConfigValidationError } from './errors';
import type { ProcessRole } from './role';
import { resolveRole } from './role';

export type QueueConfig =
  | { readonly provider: 'in-process' }
  | { readonly provider: 'sqs'; readonly queueUrl: string; readonly region: string };

export type StorageConfig =
  | { readonly provider: 'local'; readonly basePath: string }
  | { readonly provider: 's3'; readonly bucket: string; readonly region: string };

/**
 * `local` carries the app key its adapter (`providers/secrets/local.ts`) derives
 * an AES-256-GCM key from (D-101) — the encrypted blob in the `secrets` table
 * is not the key, only what it protects. `aws-secrets-manager` is unchanged
 * from before initiative J.
 */
export type SecretsConfig =
  | { readonly provider: 'local'; readonly encryptionKey: string }
  | { readonly provider: 'aws-secrets-manager'; readonly region: string; readonly prefix: string };

export type EmailConfig =
  | { readonly provider: 'ses'; readonly fromAddress: string; readonly region: string }
  | { readonly provider: 'log'; readonly fromAddress: string };

export type BankFeedConfig = { readonly provider: 'csv-ofx' };

/**
 * Document extraction (initiative O). `anthropic` carries the two settings the
 * hosted adapter needs once it is written — a model id and a region — even though
 * the adapter itself throws at construction today (see `providers/extraction/
 * anthropic.ts`): the config shape is what a future implementation reads, and
 * inventing it then would mean widening a union that already shipped.
 */
export type DocumentExtractionConfig =
  | { readonly provider: 'deterministic' }
  | { readonly provider: 'anthropic'; readonly model: string; readonly region: string };

/** Inbound mail (initiative O). `ses-inbound` carries the region its adapter needs. */
export type InboundMailConfig =
  { readonly provider: 'dev' } | { readonly provider: 'ses-inbound'; readonly region: string };

/**
 * A discriminated union for the same reason the providers are (see the file
 * header): `enabled: true` carries a non-empty, already-validated allowlist, so
 * `src/transport/cors.ts` registers hooks against a guarantee instead of
 * re-deriving one from an optional string. `enabled: false` is the default and
 * registers nothing at all — a same-origin deployment runs the same hook chain it
 * ran before OB-029.
 */
export type CorsConfig =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly allowedOrigins: readonly string[] };

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly role: ProcessRole;
  readonly logLevel: LogLevel;
  readonly http: {
    readonly host: string;
    readonly port: number;
  };
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly database: string;
    readonly poolSize: number;
    /**
     * DDL credentials, present only under OPENBOOKS_ROLE=migrate.
     *
     * Two users, by design (spec §12): the application connects as a user with
     * no UPDATE/DELETE on the journal tables, so journals are append-only at the
     * database level rather than by convention. Keeping these off the api and
     * worker roles means a compromised API process holds no path to DDL.
     */
    readonly migrator?: {
      readonly user: string;
      readonly password: string;
    };
  };
  readonly session: {
    readonly secret: string;
    readonly cookieSecure: boolean;
    readonly cookieDomain?: string;
  };
  /**
   * Not nested under `http`, despite being an HTTP concern, because it is bound
   * to `session.cookieDomain` — `corsIssues` refuses a list the session cookie
   * could never reach — and burying that relationship one level down inside the
   * bind host and port would hide it.
   */
  readonly cors: CorsConfig;
  /**
   * Where a link in an outbound email should point (OB-040).
   *
   * Top-level rather than under `http`, because `http` is where this process
   * *binds* and this is where the world *reaches the product* — in the hosted
   * layout those are a container port and a CloudFront domain, and filing them
   * together invites reading one as the other. Optional: see `APP_BASE_URL` in
   * `env.ts` for why the server cannot derive it.
   */
  readonly appBaseUrl?: string;
  readonly providers: {
    readonly queue: QueueConfig;
    readonly storage: StorageConfig;
    readonly secrets: SecretsConfig;
    readonly email: EmailConfig;
    readonly bankFeed: BankFeedConfig;
    readonly documentExtraction: DocumentExtractionConfig;
    readonly inboundMail: InboundMailConfig;
  };
}

/**
 * Reads a variable the selected provider requires. Unreachable once
 * `PROVIDER_REQUIREMENTS` lists everything the selection below reads; if it does
 * fire, the table has a gap and the fix belongs there, not here.
 */
function demand<K extends keyof Env>(env: Env, variable: K): NonNullable<Env[K]> {
  const value = env[variable];
  if (value === undefined) {
    throw new Error(
      `config: ${String(variable)} is read by a selected provider but missing from ` +
        'PROVIDER_REQUIREMENTS — startup validation could not have caught it.',
    );
  }
  return value;
}

function selectQueue(env: Env): QueueConfig {
  switch (env.QUEUE_PROVIDER) {
    case 'in-process':
      return { provider: 'in-process' };
    case 'sqs':
      return {
        provider: 'sqs',
        queueUrl: demand(env, 'SQS_QUEUE_URL'),
        region: demand(env, 'AWS_REGION'),
      };
  }
}

function selectStorage(env: Env): StorageConfig {
  switch (env.STORAGE_PROVIDER) {
    case 'local':
      return { provider: 'local', basePath: demand(env, 'STORAGE_LOCAL_PATH') };
    case 's3':
      return {
        provider: 's3',
        bucket: demand(env, 'S3_BUCKET'),
        region: demand(env, 'AWS_REGION'),
      };
  }
}

function selectSecrets(env: Env): SecretsConfig {
  switch (env.SECRETS_PROVIDER) {
    case 'local':
      return { provider: 'local', encryptionKey: demand(env, 'SECRETS_ENCRYPTION_KEY') };
    case 'aws-secrets-manager':
      return {
        provider: 'aws-secrets-manager',
        region: demand(env, 'AWS_REGION'),
        prefix: demand(env, 'SECRETS_MANAGER_PREFIX'),
      };
  }
}

function selectEmail(env: Env): EmailConfig {
  switch (env.EMAIL_PROVIDER) {
    case 'ses':
      return {
        provider: 'ses',
        fromAddress: demand(env, 'EMAIL_FROM_ADDRESS'),
        region: demand(env, 'AWS_REGION'),
      };
    case 'log':
      return { provider: 'log', fromAddress: demand(env, 'EMAIL_FROM_ADDRESS') };
  }
}

function selectDocumentExtraction(env: Env): DocumentExtractionConfig {
  switch (env.EXTRACTION_PROVIDER) {
    case 'deterministic':
      return { provider: 'deterministic' };
    case 'anthropic':
      return {
        provider: 'anthropic',
        model: demand(env, 'EXTRACTION_MODEL'),
        region: demand(env, 'AWS_REGION'),
      };
  }
}

function selectInboundMail(env: Env): InboundMailConfig {
  switch (env.INBOUND_MAIL_PROVIDER) {
    case 'dev':
      return { provider: 'dev' };
    case 'ses-inbound':
      return { provider: 'ses-inbound', region: demand(env, 'AWS_REGION') };
  }
}

function selectCors(env: Env): CorsConfig {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw === undefined) return { enabled: false };
  return { enabled: true, allowedOrigins: parseOriginList(raw) };
}

function shape(role: ProcessRole, env: Env): Config {
  return {
    nodeEnv: env.NODE_ENV,
    role,
    logLevel: env.LOG_LEVEL,
    http: {
      host: env.HTTP_HOST,
      port: env.HTTP_PORT,
    },
    database: {
      host: env.DATABASE_HOST,
      port: env.DATABASE_PORT,
      user: env.DATABASE_USER,
      password: env.DATABASE_PASSWORD,
      database: env.DATABASE_NAME,
      poolSize: env.DATABASE_POOL_SIZE,
      // Spread for the same exactOptionalPropertyTypes reason as cookieDomain.
      ...(env.DATABASE_MIGRATOR_USER === undefined || env.DATABASE_MIGRATOR_PASSWORD === undefined
        ? {}
        : {
            migrator: {
              user: env.DATABASE_MIGRATOR_USER,
              password: env.DATABASE_MIGRATOR_PASSWORD,
            },
          }),
    },
    session: {
      secret: env.SESSION_SECRET,
      cookieSecure: env.SESSION_COOKIE_SECURE,
      // Spread rather than `cookieDomain: env.SESSION_COOKIE_DOMAIN` because
      // exactOptionalPropertyTypes distinguishes an absent key from `undefined`.
      ...(env.SESSION_COOKIE_DOMAIN === undefined
        ? {}
        : { cookieDomain: env.SESSION_COOKIE_DOMAIN }),
    },
    cors: selectCors(env),
    // Spread for the same exactOptionalPropertyTypes reason as cookieDomain.
    ...(env.APP_BASE_URL === undefined ? {} : { appBaseUrl: env.APP_BASE_URL }),
    providers: {
      queue: selectQueue(env),
      storage: selectStorage(env),
      secrets: selectSecrets(env),
      email: selectEmail(env),
      bankFeed: { provider: env.BANK_FEED_PROVIDER },
      documentExtraction: selectDocumentExtraction(env),
      inboundMail: selectInboundMail(env),
    },
  };
}

/**
 * `readonly` alone is a compile-time promise. Freezing makes it hold for the
 * plain-JS paths that will inevitably touch this object — a Fastify plugin's
 * options bag, a log serializer, a test helper.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates an environment and resolves it into config. Pure in the argument, so
 * tests exercise it directly; `getConfig()` is the process-wide application of
 * it to `process.env`.
 *
 * Two passes, in this order: the schema first, then provider requirements. A
 * provider's requirements are only meaningful once its selector is known to be a
 * legal value, so reporting both at once would mean reporting requirements for a
 * provider the operator never chose.
 *
 * @throws {InvalidRoleError} on an unrecognised OPENBOOKS_ROLE.
 * @throws {ConfigValidationError} on any other invalid or missing variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const role = resolveRole(env);

  const parsed = envSchema.safeParse(normalizeEnv(env));
  if (!parsed.success) throw new ConfigValidationError(schemaIssues(parsed.error));

  const missing = missingProviderVars(parsed.data);
  if (missing.length > 0) throw new ConfigValidationError(missing);

  const missingMigrator = missingMigratorVars(role, parsed.data);
  if (missingMigrator.length > 0) throw new ConfigValidationError(missingMigrator);

  const cors = corsIssues(parsed.data);
  if (cors.length > 0) throw new ConfigValidationError(cors);

  return deepFreeze(shape(role, parsed.data));
}

/**
 * The migrate role, and only the migrate role, requires DDL credentials.
 *
 * Conditional on role rather than always-required so the api and worker roles
 * cannot be handed DDL credentials they have no use for — the two-user split in
 * spec §12 is what makes journals append-only, and it is weakened by every
 * process that holds the migrator password without needing it.
 */
function missingMigratorVars(role: ProcessRole, env: Env): ConfigIssue[] {
  if (role !== 'migrate') return [];

  const required = ['DATABASE_MIGRATOR_USER', 'DATABASE_MIGRATOR_PASSWORD'] as const;
  return required
    .filter((variable) => env[variable] === undefined)
    .map((variable) => ({
      variable,
      message: 'must be set — required by OPENBOOKS_ROLE=migrate',
    }));
}
