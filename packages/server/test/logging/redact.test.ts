import { describe, expect, it } from 'vitest';
import { loadConfig, redactConfig, REDACTED } from '../../src/config/index';
import { isSecretLogField, redactLogRecord } from '../../src/logging/index';

const baseEnv = {
  DATABASE_HOST: 'mysql',
  DATABASE_USER: 'openbooks_app',
  DATABASE_PASSWORD: 'db-hunter2',
  DATABASE_NAME: 'openbooks',
  SESSION_SECRET: 'session-'.repeat(8),
  STORAGE_LOCAL_PATH: '/var/lib/openbooks/storage',
  EMAIL_FROM_ADDRESS: 'openbooks@example.test',
  // The self-host default SECRETS_PROVIDER is `local` (initiative J, D-101), whose
  // app key is itself a secret this suite must find redacted — see below.
  SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
} satisfies NodeJS.ProcessEnv;

/** Every path whose value came back redacted, in dotted form. */
const redactedPaths = (value: unknown, prefix = ''): readonly string[] => {
  if (value === REDACTED) return [prefix];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    redactedPaths(nested, prefix === '' ? key : `${prefix}.${key}`),
  );
};

describe('agreement with src/config/redact.ts', () => {
  const config = loadConfig({ ...baseEnv });

  const viaConfig = redactedPaths(redactConfig(config));
  const viaLog = redactedPaths(redactLogRecord({ ...config }));

  it('redacts the secrets the config module knows about', () => {
    // Three: the database password and the session secret as before, plus the
    // `local` secrets adapter's own app key (initiative J, D-101) now that it is
    // the self-host default. `ses` authenticates with the task role and `log`
    // authenticates with nothing, so neither email provider holds one.
    expect(viaConfig).toEqual([
      'database.password',
      'session.secret',
      'providers.secrets.encryptionKey',
    ]);
  });

  /**
   * The load-bearing assertion. The two modules keep separate field lists (see the
   * note at the top of src/logging/redact.ts) and this is what stops them drifting:
   * anything config considers a secret must also be redacted in a log line.
   */
  it('redacts a superset of them', () => {
    expect(viaConfig.length).toBeGreaterThan(0);
    for (const path of viaConfig) {
      // A redacted ancestor covers its descendants: the log side matches on the
      // field-name substring `secret`, so it blanks the whole `providers.secrets`
      // subtree, whereas the config side redacts the exact `encryptionKey` leaf.
      // That is still a superset — the leaf is redacted, via its parent — so the
      // check accepts an exact path or any redacted prefix of it.
      const covered = viaLog.some((logged) => path === logged || path.startsWith(`${logged}.`));
      expect(covered, `${path} is not redacted (nor is any ancestor) in log output`).toBe(true);
    }
  });

  it('over-redacts rather than under-redacts', () => {
    // `providers.secrets` is a provider *selection*, not a secret, and the
    // substring match takes the whole subtree. Documented behaviour: a lost
    // debugging field is cheaper than a logged credential.
    expect(viaLog).toContain('providers.secrets');
  });

  it('leaves no secret value anywhere in the serialized record', () => {
    const serialized = JSON.stringify(redactLogRecord({ ...config }));
    expect(serialized).not.toContain('db-hunter2');
    expect(serialized).not.toContain('session-session-');
  });
});

describe('isSecretLogField', () => {
  it('matches regardless of case and separators', () => {
    for (const field of [
      'password',
      'Password',
      'passwordHash',
      'DATABASE_PASSWORD',
      'secret',
      'clientSecret',
      'token',
      'session-token',
      'refresh_token',
      'authorization',
      'Authorization',
      'cookie',
      'set-cookie',
      'apiKey',
      'API_KEY',
      'credentials',
      'passphrase',
      'privateKey',
    ]) {
      expect(isSecretLogField(field), field).toBe(true);
    }
  });

  it('leaves ordinary fields alone', () => {
    for (const field of ['orgId', 'requestId', 'userId', 'msg', 'journalId', 'amount', 'email']) {
      expect(isSecretLogField(field), field).toBe(false);
    }
  });
});
