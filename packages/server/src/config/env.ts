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
  DOCUMENT_EXTRACTION_PROVIDERS,
  EMAIL_PROVIDERS,
  INBOUND_MAIL_PROVIDERS,
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

/**
 * Where operational logs go, beyond stdout (OB-255). `stdout` is the always-on
 * default and the current behaviour — pino → the container's stdout, captured by
 * `docker compose logs`. `db` additionally persists redacted lines to the `logs`
 * table (D-255-1) so a self-host operator can query them in SQL; stdout stays on
 * underneath it, so a DB-sink failure can never take the logs with it. The hosted
 * shippers (`otel`/`http`/`cloudwatch`) are a deferred slot behind the same
 * `LogSinkProvider` seam — the `sqs`/`aws-secrets-manager` idiom — and are not yet
 * selectable here.
 */
export const LOG_SINKS = ['stdout', 'db'] as const;
export type LogSink = (typeof LOG_SINKS)[number];

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
  // Persist logs to the DB (OB-255). Off by default — the self-host operator opts
  // in with LOG_SINK=db; stdout is unconditional either way.
  LOG_SINK: oneOf(LOG_SINKS).default('stdout'),
  // The retention window the daily prune enforces on the `logs` table when
  // LOG_SINK=db (D-255-3/D-255-5). 30 days by default, matching the M5 event-log
  // precedent; capped at ten years so a fat-fingered value cannot mean "never
  // prune". Ignored when LOG_SINK=stdout (nothing is persisted to prune).
  LOG_RETENTION_DAYS: z.coerce
    .number({ error: 'must be an integer between 1 and 3650' })
    .int({ error: 'must be an integer between 1 and 3650' })
    .min(1, { error: 'must be an integer between 1 and 3650' })
    .max(3650, { error: 'must be an integer between 1 and 3650' })
    .default(30),

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

  // --- CORS (OB-029) ------------------------------------------------------
  // A comma-separated list of browser origins allowed to call this API. Unset
  // means no CORS layer at all, which is correct for every same-origin
  // deployment: the Compose stack, a reverse-proxied self-host, and M2's Vite
  // dev proxy. Only the hosted split — bundle on CloudFront, API on its own
  // hostname — needs it, so the shape that ships nothing by default is the one
  // that cannot weaken a deployment that never asked for it.
  //
  // Validated by `corsIssues` rather than here, because the check that matters
  // is a relationship with SESSION_COOKIE_DOMAIN and a field cannot see its
  // siblings from inside the schema.
  CORS_ALLOWED_ORIGINS: z.string().optional(),

  // --- Provider selectors (spec §3) ---------------------------------------
  QUEUE_PROVIDER: oneOf(QUEUE_PROVIDERS).default(SELF_HOST_PROVIDERS.QUEUE_PROVIDER),
  STORAGE_PROVIDER: oneOf(STORAGE_PROVIDERS).default(SELF_HOST_PROVIDERS.STORAGE_PROVIDER),
  SECRETS_PROVIDER: oneOf(SECRETS_PROVIDERS).default(SELF_HOST_PROVIDERS.SECRETS_PROVIDER),
  EMAIL_PROVIDER: oneOf(EMAIL_PROVIDERS).default(SELF_HOST_PROVIDERS.EMAIL_PROVIDER),
  BANK_FEED_PROVIDER: oneOf(BANK_FEED_PROVIDERS).default(SELF_HOST_PROVIDERS.BANK_FEED_PROVIDER),
  // Initiative O (OB-185…191): document extraction and inbound mail. Same
  // self-host default reasoning as every selector above — the schema default is
  // the Compose stack's story, and a hosted deploy states its choice explicitly.
  EXTRACTION_PROVIDER: oneOf(DOCUMENT_EXTRACTION_PROVIDERS).default(
    SELF_HOST_PROVIDERS.EXTRACTION_PROVIDER,
  ),
  INBOUND_MAIL_PROVIDER: oneOf(INBOUND_MAIL_PROVIDERS).default(
    SELF_HOST_PROVIDERS.INBOUND_MAIL_PROVIDER,
  ),

  // --- Provider settings --------------------------------------------------
  // Optional here and required conditionally by PROVIDER_REQUIREMENTS. The
  // schema cannot express "required if a sibling has a given value" without
  // producing exactly the generic error message this ticket exists to avoid.
  AWS_REGION: z.string().optional(),
  SQS_QUEUE_URL: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  STORAGE_LOCAL_PATH: z.string().optional(),
  SECRETS_MANAGER_PREFIX: z.string().optional(),
  // The `local` secrets adapter's app key (initiative J, D-101): what
  // `providers/secrets/local.ts` derives its AES-256-GCM key from. Required
  // only when SECRETS_PROVIDER=local, enforced by PROVIDER_REQUIREMENTS below,
  // for `SESSION_SECRET`'s length reason — a short key is a key an attacker
  // who reads the encrypted blob can brute-force.
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .min(32, { error: 'must be at least 32 characters' })
    .optional(),
  EMAIL_FROM_ADDRESS: z.string().optional(),
  // The `anthropic` extraction adapter's model id (initiative O). Only ever read
  // once that adapter is implemented — today it throws at construction regardless
  // (see `providers/extraction/anthropic.ts`) — but PROVIDER_REQUIREMENTS still
  // names it, so choosing EXTRACTION_PROVIDER=anthropic fails at startup rather
  // than at the adapter's throw.
  EXTRACTION_MODEL: z.string().optional(),

  // --- The public origin of the web app (OB-040) --------------------------
  // Only the invite email reads this, and it is optional because the server
  // cannot derive it: HTTP_HOST is a bind address (`0.0.0.0` in a container),
  // so which origin a browser reaches this deployment on is a fact about DNS
  // and the load balancer that config never sees — the same limit `corsIssues`
  // records below. Unset, an invite link is emitted as a path for an operator
  // to prefix, which is honest; a plausible-looking default would emit links
  // that resolve to the wrong host and look correct doing it.
  APP_BASE_URL: z
    .string()
    .refine(isAbsoluteHttpUrl, { error: 'must be an absolute http:// or https:// URL' })
    .optional(),
});

/**
 * Checked at startup rather than where the link is built, because the failure is
 * otherwise invisible: `new URL(path, base)` throws only when the invite is being
 * sent, which is inside the best-effort send that OB-040 deliberately does not let
 * fail a committed write — so a malformed value would cost a real user their invite
 * and produce one log line nobody was watching for.
 */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

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
    local: ['SECRETS_ENCRYPTION_KEY'],
  },
  EMAIL_PROVIDER: {
    ses: ['EMAIL_FROM_ADDRESS', 'AWS_REGION'],
    // A `From` address is required of the log adapter too. It is what the message
    // would have been sent as, and an adapter that logged a message no real
    // transport could have delivered would be a rehearsal of the wrong thing.
    log: ['EMAIL_FROM_ADDRESS'],
  },
  BANK_FEED_PROVIDER: {
    // Reads an uploaded file; needs nothing from the environment.
    'csv-ofx': [],
  },
  EXTRACTION_PROVIDER: {
    anthropic: ['EXTRACTION_MODEL', 'AWS_REGION'],
    // Parses uploaded bytes as text; needs nothing from the environment.
    deterministic: [],
  },
  INBOUND_MAIL_PROVIDER: {
    'ses-inbound': ['AWS_REGION'],
    // Parses a JSON webhook body with no signature verification; needs nothing
    // from the environment.
    dev: [],
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
 * The seven checks are written out rather than looped because a loop over the
 * selectors loses the correlation between a selector and its own provider
 * union, and recovering it costs a cast. Adding a *provider* still touches only
 * the table above; only a new *selector* touches this function.
 */
export function missingProviderVars(env: Env): ConfigIssue[] {
  return [
    ...missingFor(env, 'QUEUE_PROVIDER', env.QUEUE_PROVIDER),
    ...missingFor(env, 'STORAGE_PROVIDER', env.STORAGE_PROVIDER),
    ...missingFor(env, 'SECRETS_PROVIDER', env.SECRETS_PROVIDER),
    ...missingFor(env, 'EMAIL_PROVIDER', env.EMAIL_PROVIDER),
    ...missingFor(env, 'BANK_FEED_PROVIDER', env.BANK_FEED_PROVIDER),
    ...missingFor(env, 'EXTRACTION_PROVIDER', env.EXTRACTION_PROVIDER),
    ...missingFor(env, 'INBOUND_MAIL_PROVIDER', env.INBOUND_MAIL_PROVIDER),
  ];
}

/**
 * The declared origins, in declaration order, with blanks dropped.
 *
 * Shared by validation and by `shape()` in `config.ts` so the list the server
 * enforces is parsed by the same function that approved it.
 */
export function parseOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function originIssue(message: string): ConfigIssue {
  return { variable: 'CORS_ALLOWED_ORIGINS', message };
}

/**
 * One declared origin, checked against what the `Origin` request header can
 * actually contain.
 *
 * The allowlist is compared by string equality against that header at request
 * time, so an entry the browser would never send verbatim is an entry that
 * matches nothing — and it fails at 3am as a CORS error in someone else's
 * console, not here. Hence the exact-form check: a browser sends
 * `https://app.example.com`, never a trailing slash, never a path, never mixed
 * case in the host. `URL.origin` is exactly that normalization, so requiring the
 * input to already equal it both rejects the near-misses and names the fix.
 */
function originEntryIssue(entry: string): ConfigIssue | undefined {
  if (entry === '*') {
    return originIssue(
      'must not contain "*" — every request to this API is credentialed (the session ' +
        'cookie), and a browser rejects Access-Control-Allow-Origin: * on a credentialed ' +
        'request. List each origin explicitly.',
    );
  }

  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return originIssue(`must be a comma-separated list of origins; "${entry}" is not a URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return originIssue(`must list only http:// or https:// origins; "${entry}" is ${url.protocol}`);
  }

  if (entry !== url.origin) {
    return originIssue(
      `must list bare scheme://host[:port] origins with no path, query, or trailing ` +
        `slash; "${entry}" should be written "${url.origin}"`,
    );
  }

  return undefined;
}

/**
 * CORS and the session cookie, checked together — the whole reason this is a
 * cross-field check rather than a schema refinement.
 *
 * The session cookie is `SameSite=Lax` (`src/modules/auth/cookie.ts`, spec §5).
 * Lax withholds the cookie from every cross-*site* subresource request, which is
 * what a `fetch` from the web bundle to the API is. So allowing an origin in CORS
 * that is not on the same site as the API buys nothing: the preflight succeeds,
 * the request goes out with no cookie, the API answers 401, and the browser
 * console shows a successful request rather than a CORS error. That is the silent
 * failure this check exists to convert into a startup failure.
 *
 * "Same site" means same registrable domain, and computing that needs the Public
 * Suffix List, which is not a dependency worth taking to validate config. So
 * `SESSION_COOKIE_DOMAIN` is treated as the operator's *declaration* of the shared
 * site and every allowed origin is required to sit within it. That is a check we
 * can make exactly, and it is required rather than merely recommended for a second
 * reason: without a `Domain` the cookie is host-only to the API hostname, which
 * works but leaves nothing in the configuration stating which site these two
 * hostnames share — so nothing to check the CORS list against. The trade is
 * deliberate and slightly loosening (a `Domain` cookie reaches every subdomain,
 * host-only reaches one); it buys a misconfiguration that fails at boot instead of
 * on the first login.
 *
 * What this cannot check: the API's own public hostname. `HTTP_HOST` is the bind
 * address (`0.0.0.0` in a container), so whether the API is itself inside
 * `SESSION_COOKIE_DOMAIN` is a fact about DNS and the load balancer that config
 * never sees. See `infra/terraform` before the first hosted deploy.
 */
export function corsIssues(env: Env): ConfigIssue[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw === undefined) return [];

  const origins = parseOriginList(raw);
  if (origins.length === 0) {
    return [originIssue('must name at least one origin, or be left unset to disable CORS')];
  }

  const malformed = origins
    .map(originEntryIssue)
    .filter((issue): issue is ConfigIssue => issue !== undefined);
  if (malformed.length > 0) return malformed;

  const domain = env.SESSION_COOKIE_DOMAIN;
  if (domain === undefined) {
    return [
      {
        variable: 'SESSION_COOKIE_DOMAIN',
        message:
          'must be set when CORS_ALLOWED_ORIGINS is set — the session cookie is SameSite=Lax, ' +
          'so it is withheld from any origin not on the same site as this API, and this ' +
          'variable is what declares that site',
      },
    ];
  }

  // A leading dot is legal in Set-Cookie (RFC 6265 §4.1.2.3) and means the same
  // thing as its absence, so it must not change what the comparison accepts.
  const site = domain.startsWith('.') ? domain.slice(1) : domain;

  return origins
    .filter((origin) => !withinSite(new URL(origin).hostname, site))
    .map((origin) =>
      originIssue(
        `"${origin}" is not within SESSION_COOKIE_DOMAIN=${domain}, so the SameSite=Lax ` +
          'session cookie would never be sent from it — every request from that origin ' +
          'would be an unauthenticated 401 with nothing in the browser to say why',
      ),
    );
}

function withinSite(hostname: string, site: string): boolean {
  return hostname === site || hostname.endsWith(`.${site}`);
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
