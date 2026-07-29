import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ProviderSelection } from '../../src/config/index';
import {
  BANK_FEED_PROVIDERS,
  ConfigValidationError,
  EMAIL_PROVIDERS,
  getConfig,
  InvalidRoleError,
  loadConfig,
  PROVIDER_REQUIREMENTS,
  QUEUE_PROVIDERS,
  REDACTED,
  redactConfig,
  SECRETS_PROVIDERS,
  SELF_HOST_PROVIDERS,
  STORAGE_PROVIDERS,
} from '../../src/config/index';

/** Required whatever the providers are. */
const alwaysRequired = {
  DATABASE_HOST: 'mysql',
  DATABASE_USER: 'openbooks_app',
  DATABASE_PASSWORD: 'app-password',
  DATABASE_NAME: 'openbooks',
  SESSION_SECRET: 'x'.repeat(32),
} satisfies NodeJS.ProcessEnv;

/**
 * The self-host baseline: the above plus what the default providers need.
 * Individual cases delete from or add to a copy of this.
 */
const baseEnv = {
  ...alwaysRequired,
  STORAGE_LOCAL_PATH: '/var/lib/openbooks/storage',
  EMAIL_FROM_ADDRESS: 'openbooks@example.test',
  // The self-host default SECRETS_PROVIDER is `local` (initiative J, D-101),
  // which requires an app key to derive its encryption key from.
  SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
} satisfies NodeJS.ProcessEnv;

const env = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...baseEnv,
  ...overrides,
});

/** The hosted selection and the variables it needs, for the s3/sqs/ses cases. */
const hostedEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv =>
  env({
    QUEUE_PROVIDER: 'sqs',
    STORAGE_PROVIDER: 's3',
    SECRETS_PROVIDER: 'aws-secrets-manager',
    EMAIL_PROVIDER: 'ses',
    AWS_REGION: 'us-east-1',
    SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/1234/openbooks',
    S3_BUCKET: 'openbooks-documents',
    SECRETS_MANAGER_PREFIX: 'openbooks/prod/',
    ...overrides,
  });

const issuesOf = (run: () => unknown): ConfigValidationError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected loadConfig to throw a ConfigValidationError');
};

describe('loadConfig', () => {
  it('resolves a valid self-host environment, defaults included', () => {
    const config = loadConfig(env());

    expect(config.role).toBe('api');
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.http).toEqual({ host: '0.0.0.0', port: 3000 });
    expect(config.database).toEqual({
      host: 'mysql',
      port: 3306,
      user: 'openbooks_app',
      password: 'app-password',
      database: 'openbooks',
      poolSize: 10,
    });
    expect(config.session.cookieSecure).toBe(true);
    expect(config.session.cookieDomain).toBeUndefined();
    expect(config.providers.queue).toEqual({ provider: 'in-process' });
    expect(config.providers.storage).toEqual({
      provider: 'local',
      basePath: '/var/lib/openbooks/storage',
    });
    expect(config.providers.secrets).toEqual({ provider: 'local', encryptionKey: 'k'.repeat(32) });
    expect(config.providers.bankFeed).toEqual({ provider: 'csv-ofx' });
  });

  it('resolves the hosted selection', () => {
    const config = loadConfig(hostedEnv());

    expect(config.providers.queue).toEqual({
      provider: 'sqs',
      queueUrl: 'https://sqs.us-east-1.amazonaws.com/1234/openbooks',
      region: 'us-east-1',
    });
    expect(config.providers.email).toEqual({
      provider: 'ses',
      fromAddress: 'openbooks@example.test',
      region: 'us-east-1',
    });
  });

  it('coerces numeric and boolean variables', () => {
    const config = loadConfig(
      env({ HTTP_PORT: '8080', DATABASE_POOL_SIZE: '25', SESSION_COOKIE_SECURE: 'false' }),
    );

    expect(config.http.port).toBe(8080);
    expect(config.database.poolSize).toBe(25);
    expect(config.session.cookieSecure).toBe(false);
    expect(config.providers.email).toEqual({
      provider: 'log',
      fromAddress: 'openbooks@example.test',
    });
  });

  it('freezes the resolved object all the way down', () => {
    const config = loadConfig(env());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.providers.storage)).toBe(true);
  });

  it('treats an empty or whitespace-only variable as unset', () => {
    expect(loadConfig(env({ SESSION_COOKIE_DOMAIN: '  ' })).session.cookieDomain).toBeUndefined();
    // Unset falls back to the default rather than coercing '' to 0.
    expect(loadConfig(env({ HTTP_PORT: '' })).http.port).toBe(3000);
    expect(issuesOf(() => loadConfig(env({ DATABASE_HOST: '' }))).issues).toEqual([
      { variable: 'DATABASE_HOST', message: 'must be set' },
    ]);
  });

  it('reports every missing always-required variable at once', () => {
    const incomplete = env();
    delete incomplete['DATABASE_PASSWORD'];
    delete incomplete['SESSION_SECRET'];

    const variables = issuesOf(() => loadConfig(incomplete)).issues.map((i) => i.variable);
    expect(variables).toEqual(['DATABASE_PASSWORD', 'SESSION_SECRET']);
  });

  it('rejects a session secret that is too short', () => {
    const error = issuesOf(() => loadConfig(env({ SESSION_SECRET: 'short' })));
    expect(error.message).toContain('SESSION_SECRET: must be at least 32 characters');
  });

  it('rejects an out-of-range port with a message naming the variable', () => {
    const error = issuesOf(() => loadConfig(env({ HTTP_PORT: '99999' })));
    expect(error.issues).toEqual([
      { variable: 'HTTP_PORT', message: 'must be a port number between 1 and 65535' },
    ]);
  });

  it('propagates an invalid role rather than swallowing it', () => {
    expect(() => loadConfig(env({ OPENBOOKS_ROLE: 'cron' }))).toThrow(InvalidRoleError);
    expect(
      loadConfig(
        env({
          OPENBOOKS_ROLE: 'migrate',
          DATABASE_MIGRATOR_USER: 'openbooks_migrator',
          DATABASE_MIGRATOR_PASSWORD: 'migrator-secret',
        }),
      ).role,
    ).toBe('migrate');
  });
});

describe('migrator credentials', () => {
  // Spec §12 splits the database identity in two: the application user holds no
  // UPDATE/DELETE on the journal tables, so DDL needs a second user. Requiring
  // those credentials only for the migrate role keeps the api and worker
  // processes from holding a password that would let them alter the schema.
  it('requires DDL credentials for the migrate role, naming the role', () => {
    const error = issuesOf(() => loadConfig(env({ OPENBOOKS_ROLE: 'migrate' })));
    expect(error.issues).toEqual([
      {
        variable: 'DATABASE_MIGRATOR_USER',
        message: 'must be set — required by OPENBOOKS_ROLE=migrate',
      },
      {
        variable: 'DATABASE_MIGRATOR_PASSWORD',
        message: 'must be set — required by OPENBOOKS_ROLE=migrate',
      },
    ]);
  });

  it('does not require them for the api or worker roles', () => {
    expect(loadConfig(env({ OPENBOOKS_ROLE: 'api' })).database.migrator).toBeUndefined();
    expect(loadConfig(env({ OPENBOOKS_ROLE: 'worker' })).database.migrator).toBeUndefined();
  });

  it('exposes them when supplied', () => {
    const config = loadConfig(
      env({
        OPENBOOKS_ROLE: 'migrate',
        DATABASE_MIGRATOR_USER: 'openbooks_migrator',
        DATABASE_MIGRATOR_PASSWORD: 'migrator-secret',
      }),
    );
    expect(config.database.migrator).toEqual({
      user: 'openbooks_migrator',
      password: 'migrator-secret',
    });
  });
});

describe('provider fail-fast validation', () => {
  it('names the provider, the selector, and every missing variable', () => {
    const error = issuesOf(() => loadConfig(env({ QUEUE_PROVIDER: 'sqs' })));

    expect(error.issues).toEqual([
      {
        variable: 'SQS_QUEUE_URL',
        message: 'must be set',
        requiredBy: { selector: 'QUEUE_PROVIDER', provider: 'sqs' },
      },
      {
        variable: 'AWS_REGION',
        message: 'must be set',
        requiredBy: { selector: 'QUEUE_PROVIDER', provider: 'sqs' },
      },
    ]);
    expect(error.message).toContain('SQS_QUEUE_URL: must be set — required by QUEUE_PROVIDER=sqs');
    expect(error.message).toContain('AWS_REGION: must be set — required by QUEUE_PROVIDER=sqs');
    expect(error.message).toContain('.env.example');
  });

  it('reports partial requirements — one missing variable out of two', () => {
    const missingFrom = env({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'us-east-1' });
    delete missingFrom['EMAIL_FROM_ADDRESS'];

    const error = issuesOf(() => loadConfig(missingFrom));
    expect(error.issues).toEqual([
      {
        variable: 'EMAIL_FROM_ADDRESS',
        message: 'must be set',
        requiredBy: { selector: 'EMAIL_PROVIDER', provider: 'ses' },
      },
    ]);
    expect(error.message).toContain('(1 problem)');
  });

  it('accumulates across selectors', () => {
    const error = issuesOf(() =>
      loadConfig(env({ QUEUE_PROVIDER: 'sqs', STORAGE_PROVIDER: 's3', STORAGE_LOCAL_PATH: '' })),
    );

    const selectors = new Set(error.issues.map((i) => i.requiredBy?.selector));
    expect(selectors).toEqual(new Set(['QUEUE_PROVIDER', 'STORAGE_PROVIDER']));
    expect(error.message).toContain('(4 problems)');
  });

  it('rejects an unknown provider value and lists the legal ones', () => {
    const error = issuesOf(() => loadConfig(env({ QUEUE_PROVIDER: 'redis' })));
    expect(error.issues).toEqual([
      { variable: 'QUEUE_PROVIDER', message: 'must be one of sqs, in-process' },
    ]);
  });

  it('does not report requirements for a provider that was never selected', () => {
    const withoutFrom = env();
    delete withoutFrom['EMAIL_FROM_ADDRESS'];

    // A bogus selector fails on its own; nothing is said about what ses or log
    // would have needed.
    const error = issuesOf(() => loadConfig({ ...withoutFrom, EMAIL_PROVIDER: 'postmark' }));
    expect(error.issues.map((i) => i.variable)).toEqual(['EMAIL_PROVIDER']);
  });

  /**
   * `smtp` was a selectable value until OB-040 and is not one now: two adapters
   * were written (`ses`, `log`) and no SMTP client was, so the name is refused at
   * startup rather than accepted and thrown on at the first invite. See
   * `src/config/providers.ts`.
   */
  it('refuses smtp, which no longer has an adapter behind it', () => {
    const error = issuesOf(() => loadConfig(env({ EMAIL_PROVIDER: 'smtp' })));
    expect(error.issues).toEqual([
      { variable: 'EMAIL_PROVIDER', message: 'must be one of ses, log' },
    ]);
  });

  /**
   * Every provider, table-driven, twice over. First: an environment carrying
   * exactly the variables the table lists resolves — a variable read during
   * selection but absent from the table would surface here as the internal
   * "missing from PROVIDER_REQUIREMENTS" error instead. Second: dropping any one
   * of those variables produces the fail-fast issue naming it.
   *
   * Generic over the selector rather than `describe.each` because `each` erases
   * the correlation between a selector and its own provider union.
   */
  const sampleValues: Record<string, string> = {
    AWS_REGION: 'eu-west-2',
    SQS_QUEUE_URL: 'https://sqs.eu-west-2.amazonaws.com/1234/q',
    S3_BUCKET: 'bucket',
    STORAGE_LOCAL_PATH: '/data',
    SECRETS_MANAGER_PREFIX: 'openbooks/',
    SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
    EMAIL_FROM_ADDRESS: 'from@example.test',
  };

  /** Everything the table asks of a complete selection, across all five. */
  const requiredVarsFor = (selection: ProviderSelection): readonly string[] => [
    ...PROVIDER_REQUIREMENTS.QUEUE_PROVIDER[selection.QUEUE_PROVIDER],
    ...PROVIDER_REQUIREMENTS.STORAGE_PROVIDER[selection.STORAGE_PROVIDER],
    ...PROVIDER_REQUIREMENTS.SECRETS_PROVIDER[selection.SECRETS_PROVIDER],
    ...PROVIDER_REQUIREMENTS.EMAIL_PROVIDER[selection.EMAIL_PROVIDER],
    ...PROVIDER_REQUIREMENTS.BANK_FEED_PROVIDER[selection.BANK_FEED_PROVIDER],
  ];

  const describeSelector = <S extends keyof ProviderSelection>(
    selector: S,
    providers: readonly ProviderSelection[S][],
  ): void => {
    describe(selector, () => {
      for (const provider of providers) {
        const required = PROVIDER_REQUIREMENTS[selector][provider];

        it(`${provider} resolves with exactly its required variables`, () => {
          const selection: ProviderSelection = {
            ...SELF_HOST_PROVIDERS,
            ...({ [selector]: provider } as Partial<ProviderSelection>),
          };
          // Built up from nothing but the always-required variables, so only the
          // table decides what is present. `ProviderSelection`'s keys are the
          // selector env var names, hence the direct spread.
          const candidate: NodeJS.ProcessEnv = { ...alwaysRequired, ...selection };
          for (const variable of requiredVarsFor(selection)) {
            candidate[variable] = sampleValues[variable];
          }

          expect(() => loadConfig(candidate)).not.toThrow();
        });

        it(`${provider} reports each of its required variables when unset`, () => {
          for (const variable of required) {
            const complete = hostedEnv({ [selector]: provider });
            delete complete[variable];

            const error = issuesOf(() => loadConfig(complete));
            expect(error.issues).toContainEqual({
              variable,
              message: 'must be set',
              requiredBy: { selector, provider },
            });
          }
        });
      }
    });
  };

  describeSelector('QUEUE_PROVIDER', QUEUE_PROVIDERS);
  describeSelector('STORAGE_PROVIDER', STORAGE_PROVIDERS);
  describeSelector('SECRETS_PROVIDER', SECRETS_PROVIDERS);
  describeSelector('EMAIL_PROVIDER', EMAIL_PROVIDERS);
  describeSelector('BANK_FEED_PROVIDER', BANK_FEED_PROVIDERS);
});

describe('redactConfig', () => {
  it('redacts the database password and the session secret', () => {
    const safe = redactConfig(loadConfig(env()));

    expect(safe.database.password).toBe(REDACTED);
    expect(safe.session.secret).toBe(REDACTED);
  });

  it('leaves non-secret values intact and does not mutate the config', () => {
    const config = loadConfig(env());
    const safe = redactConfig(config);

    expect(safe.database.host).toBe('mysql');
    expect(safe.providers.storage).toEqual({
      provider: 'local',
      basePath: '/var/lib/openbooks/storage',
    });
    expect(config.database.password).toBe('app-password');
    expect(JSON.stringify(safe)).not.toContain('app-password');
  });
});

describe('.env.example', () => {
  /**
   * The quickstart is `cp .env.example .env && docker compose up`, so the
   * committed example has to satisfy its own schema. Without this, the file
   * drifts the first time a variable is added and the drift is only found by
   * someone following the README.
   */
  it('resolves as-is', () => {
    const path = fileURLToPath(new URL('../../../../.env.example', import.meta.url));
    const parsed: NodeJS.ProcessEnv = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match?.[1] !== undefined) parsed[match[1]] = match[2];
    }

    expect(Object.keys(parsed).length).toBeGreaterThan(10);
    const config = loadConfig(parsed);
    // The example documents the self-host deployment, so it must select it.
    expect(config.providers.queue.provider).toBe(SELF_HOST_PROVIDERS.QUEUE_PROVIDER);
    expect(config.providers.storage.provider).toBe(SELF_HOST_PROVIDERS.STORAGE_PROVIDER);
    expect(config.providers.secrets.provider).toBe(SELF_HOST_PROVIDERS.SECRETS_PROVIDER);
    expect(config.providers.email.provider).toBe(SELF_HOST_PROVIDERS.EMAIL_PROVIDER);
    expect(config.providers.bankFeed.provider).toBe(SELF_HOST_PROVIDERS.BANK_FEED_PROVIDER);
  });
});

describe('getConfig', () => {
  it('resolves process.env once and returns the same frozen object', () => {
    const saved = { ...process.env };
    try {
      Object.assign(process.env, baseEnv);
      const first = getConfig();
      // A subsequent change to the environment must not be picked up: config is
      // resolved once at startup.
      process.env['DATABASE_NAME'] = 'somewhere-else';
      expect(getConfig()).toBe(first);
      expect(first.database.database).toBe('openbooks');
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
