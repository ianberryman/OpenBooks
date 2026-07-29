/**
 * Transport test harness.
 *
 * These tests use `app.inject()` and never bind a port. That is the reason
 * `buildApp` returns an instance instead of listening on import: the whole stack —
 * hooks, context scope, validation, serialization, the error handler — runs, and
 * the test needs no socket, no teardown, and no free port.
 *
 * Nothing here touches the database. The server project's `globalSetup` still
 * starts the shared MySQL container (see `test/README.md`), which these files pay
 * for and do not use.
 */
import type { Config } from '../../src/config/index';
import { loadConfig } from '../../src/config/index';
import type { Logger } from '../../src/logging/index';
import { createLogger } from '../../src/logging/index';
import type { BuildAppOptions } from '../../src/transport/index';
import { buildApp } from '../../src/transport/index';
import type { App } from '../../src/transport/index';

/**
 * A config built through the real `loadConfig`, so the tests exercise the same
 * validated, frozen object production does rather than a literal that drifts when a
 * field is added.
 */
export function testConfig(overrides: NodeJS.ProcessEnv = {}): Config {
  return loadConfig({
    OPENBOOKS_ROLE: 'api',
    NODE_ENV: 'test',
    LOG_LEVEL: 'trace',
    DATABASE_HOST: 'unused',
    DATABASE_USER: 'unused',
    DATABASE_PASSWORD: 'unused',
    DATABASE_NAME: 'unused',
    SESSION_SECRET: 's'.repeat(40),
    STORAGE_LOCAL_PATH: '/tmp/openbooks-test',
    EMAIL_FROM_ADDRESS: 'tests@example.invalid',
    // The self-host default SECRETS_PROVIDER is `local` (initiative J, D-101),
    // which requires an app key to derive its encryption key from.
    SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
    ...overrides,
  });
}

export interface LogCapture {
  readonly logger: Logger;
  /** Every record written, parsed. */
  readonly records: () => Record<string, unknown>[];
  /** The raw NDJSON, for asserting that a string is or is not anywhere in the logs. */
  readonly text: () => string;
}

/**
 * A real pino logger over a capture stream — not a mock.
 *
 * The point of several of these tests is that the redaction walk and the
 * provenance mixin in `src/logging/` actually ran, and a mock logger would assert
 * that we called a method rather than what was written.
 */
export function captureLogs(config: Config): LogCapture {
  const chunks: string[] = [];
  const logger = createLogger(config, {
    write(chunk: string) {
      chunks.push(chunk);
    },
  });

  return {
    logger,
    records: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => chunks.join(''),
  };
}

export interface TestApp {
  readonly app: App;
  readonly logs: LogCapture;
}

/**
 * Builds an app with logs captured. Routes are added by the caller *after* this
 * returns and before the first `inject()`, which is legal because `buildApp` adds
 * every hook before registering any route of its own.
 */
export async function buildTestApp(
  options: Omit<BuildAppOptions, 'config' | 'logger'> & { readonly config?: Config } = {},
): Promise<TestApp> {
  const { config: provided, ...rest } = options;
  const config = provided ?? testConfig();
  const logs = captureLogs(config);
  const app = await buildApp({ ...rest, config, logger: logs.logger });
  return { app, logs };
}

/** The error envelope, narrowed. Tests assert on `code`, not on prose. */
export interface WireErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
  };
}

export function errorBody(payload: string): WireErrorBody {
  return JSON.parse(payload) as WireErrorBody;
}
