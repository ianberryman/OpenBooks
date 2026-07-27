import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config/index';
import { loadConfig, REDACTED } from '../../src/config/index';
import { createRequestContext, runInContext } from '../../src/context/index';
import { InternalError, ValidationError } from '../../src/errors/index';
import { createLogger, prettyTransport } from '../../src/logging/index';

const baseEnv = {
  DATABASE_HOST: 'mysql',
  DATABASE_USER: 'openbooks_app',
  DATABASE_PASSWORD: 'app-password',
  DATABASE_NAME: 'openbooks',
  SESSION_SECRET: 'x'.repeat(32),
  STORAGE_LOCAL_PATH: '/var/lib/openbooks/storage',
  EMAIL_FROM_ADDRESS: 'openbooks@example.test',
} satisfies NodeJS.ProcessEnv;

const config = (overrides: NodeJS.ProcessEnv = {}): Config =>
  loadConfig({ ...baseEnv, NODE_ENV: 'test', LOG_LEVEL: 'trace', ...overrides });

interface Capture {
  readonly stream: DestinationStream;
  lines(): readonly Record<string, unknown>[];
}

const capture = (): Capture => {
  const written: string[] = [];
  return {
    stream: {
      write(chunk: string): void {
        written.push(chunk);
      },
    },
    lines: () => written.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
  };
};

const context = (orgId: string) =>
  createRequestContext({
    requestId: `req-${orgId}`,
    orgId,
    userId: `user-${orgId}`,
    roleId: 'role-bookkeeper',
    actorType: 'user',
    actorId: `user-${orgId}`,
    invocationMode: 'interactive',
  });

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('actor provenance (A13)', () => {
  it('appears on every line without the caller attaching anything', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    runInContext(context('org-a'), () => {
      logger.info('journal posted');
      logger.warn({ journalId: 'j-1' }, 'unusual entry');
    });

    const lines = sink.lines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({
        requestId: 'req-org-a',
        orgId: 'org-a',
        userId: 'user-org-a',
        roleId: 'role-bookkeeper',
        actorType: 'user',
        actorId: 'user-org-a',
        invocationMode: 'interactive',
      });
    }
    expect(lines[1]).toMatchObject({ journalId: 'j-1', msg: 'unusual entry' });
  });

  it('reaches child loggers too', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    runInContext(context('org-a'), () => {
      logger.child({ component: 'posting' }).info('hello');
    });

    expect(sink.lines()[0]).toMatchObject({ component: 'posting', orgId: 'org-a' });
  });

  it('cannot be overwritten by the call site', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    runInContext(context('org-a'), () => {
      logger.info({ orgId: 'org-b', userId: 'someone-else' }, 'attributed to the real actor');
    });

    expect(sink.lines()[0]).toMatchObject({ orgId: 'org-a', userId: 'user-org-a' });
  });

  it('still logs outside a request scope, with no provenance invented', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    logger.info('starting up');

    const line = sink.lines()[0] ?? {};
    expect(line).toMatchObject({ msg: 'starting up', role: 'api' });
    expect('orgId' in line).toBe(false);
    expect('actorType' in line).toBe(false);
  });

  it('attributes correctly while requests interleave', async () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    const request = async (orgId: string): Promise<void> => {
      for (let step = 0; step < 4; step += 1) {
        await delay(1 + ((step + orgId.length) % 3));
        logger.info({ step }, `work in ${orgId}`);
      }
    };

    await Promise.all(
      ['org-a', 'org-b', 'org-c'].map((orgId) =>
        runInContext(context(orgId), () => request(orgId)),
      ),
    );

    const lines = sink.lines();
    expect(lines).toHaveLength(12);
    for (const line of lines) {
      expect(line['msg']).toBe(`work in ${String(line['orgId'])}`);
      expect(line['requestId']).toBe(`req-${String(line['orgId'])}`);
    }
  });
});

describe('configuration', () => {
  it('takes its level from config', () => {
    const sink = capture();
    const logger = createLogger(config({ LOG_LEVEL: 'warn' }), sink.stream);

    logger.debug('invisible');
    logger.info('also invisible');
    logger.warn('visible');

    expect(sink.lines().map((line) => line['msg'])).toEqual(['visible']);
  });

  it('records which of the three roles produced the line', () => {
    const sink = capture();
    const logger = createLogger(config({ OPENBOOKS_ROLE: 'worker' }), sink.stream);

    logger.info('idling');

    expect(sink.lines()[0]).toMatchObject({ role: 'worker' });
  });

  it('selects the pretty transport in development only', () => {
    expect(prettyTransport(config({ NODE_ENV: 'development' }))?.target).toBe('pino-pretty');
    expect(prettyTransport(config({ NODE_ENV: 'production' }))).toBeUndefined();
    expect(prettyTransport(config({ NODE_ENV: 'test' }))).toBeUndefined();
  });
});

describe('redaction', () => {
  it('redacts secret-named fields wherever they appear', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    logger.info(
      {
        database: { host: 'mysql', password: 'hunter2' },
        headers: { 'content-type': 'application/json', authorization: 'Bearer abc' },
        apiKey: 'ak_live_1',
        SESSION_TOKEN: 'st_1',
        members: [{ email: 'a@example.test', passwordHash: '$argon2id$…' }],
        deep: { a: { b: { c: { clientSecret: 's' } } } },
      },
      'request',
    );

    const line = sink.lines()[0] ?? {};
    expect(line).toMatchObject({
      database: { host: 'mysql', password: REDACTED },
      headers: { 'content-type': 'application/json', authorization: REDACTED },
      apiKey: REDACTED,
      SESSION_TOKEN: REDACTED,
      members: [{ email: 'a@example.test', passwordHash: REDACTED }],
      deep: { a: { b: { c: { clientSecret: REDACTED } } } },
    });
  });

  it('survives a cycle instead of hanging', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    const node: Record<string, unknown> = { name: 'root' };
    node['self'] = node;
    logger.info({ node }, 'cyclic');

    expect(sink.lines()[0]).toMatchObject({ node: { name: 'root', self: '[circular]' } });
  });

  it('stringifies bigint rather than throwing on it', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    // Money is BIGINT minor units end to end (OB-005); JSON.stringify throws on one.
    logger.info({ totalMinorUnits: 123_456_789_012_345n }, 'trial balance');

    expect(sink.lines()[0]).toMatchObject({ totalMinorUnits: '123456789012345' });
  });
});

describe('error serialization', () => {
  it('carries code, status, and details, and redacts inside them', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    const err = new InternalError('posting failed', { table: 'journals', password: 'hunter2' });
    runInContext(context('org-a'), () => {
      logger.error({ err }, 'posting failed');
    });

    const line = sink.lines()[0] ?? {};
    expect(line).toMatchObject({
      orgId: 'org-a',
      err: {
        type: 'InternalError',
        message: 'posting failed',
        code: 'internal_error',
        status: 500,
        details: { table: 'journals', password: REDACTED },
      },
    });
    // pino's own serializer re-attaches the untouched error as `raw`, which would
    // reintroduce every field it had just redacted.
    expect(line['err']).not.toHaveProperty('raw');
    expect(JSON.stringify(line)).not.toContain('hunter2');
  });

  it('keeps a stack and the wrapped cause', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    const err = new Error('outer', { cause: new ValidationError('inner') });
    logger.error({ err }, 'wrapped');

    expect(sink.lines()[0]).toMatchObject({
      err: {
        type: 'Error',
        message: 'outer',
        cause: { type: 'ValidationError', message: 'inner', code: 'validation_failed' },
      },
    });
    expect(sink.lines()[0]?.['err']).toHaveProperty('stack');
  });

  it('serializes an error passed as the whole log argument', () => {
    const sink = capture();
    const logger = createLogger(config(), sink.stream);

    logger.error(new ValidationError('Journal does not balance.'));

    expect(sink.lines()[0]).toMatchObject({
      msg: 'Journal does not balance.',
      err: { type: 'ValidationError', code: 'validation_failed', status: 400 },
    });
  });
});
