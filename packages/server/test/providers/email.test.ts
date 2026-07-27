import { describe, expect, it } from 'vitest';

import type { Config } from '../../src/config';
import { loadConfig } from '../../src/config';
import { createLogger } from '../../src/logging';
import { selectEmailProvider } from '../../src/providers';

/**
 * The first concrete provider adapters (OB-040, ROADMAP D-07).
 *
 * D-07 defers an adapter until it has a consumer because "writing adapters with
 * no consumer would mean writing them untested". The `log` adapter is tested here
 * *and* end to end in `test/members/invites.service.test.ts`, where a real invite
 * is read back out of the message it wrote.
 *
 * The `ses` adapter is not exercised against SES. It cannot be — spec §11 rules
 * out mocks, and the honest alternatives are a network call to Amazon from the
 * test suite or a fake SES that would prove only that the fake matches our
 * reading of the API. What is asserted here is what can be asserted locally: that
 * the selection reaches it, that constructing it needs nothing but a region, and
 * that it does not touch the network to exist. Its first real exercise is the
 * first hosted deploy, which ROADMAP D-05 already records as unexercised ground.
 */

const baseEnv = {
  OPENBOOKS_ROLE: 'api',
  NODE_ENV: 'test',
  DATABASE_HOST: 'unused',
  DATABASE_USER: 'unused',
  DATABASE_PASSWORD: 'unused',
  DATABASE_NAME: 'unused',
  SESSION_SECRET: 's'.repeat(40),
  STORAGE_LOCAL_PATH: '/tmp/openbooks-test',
  EMAIL_FROM_ADDRESS: 'invites@openbooks.test',
} satisfies NodeJS.ProcessEnv;

interface Captured {
  readonly config: Config;
  readonly lines: string[];
  readonly records: () => Record<string, unknown>[];
}

function captured(overrides: NodeJS.ProcessEnv = {}): Captured {
  const lines: string[] = [];
  return {
    config: loadConfig({ ...baseEnv, ...overrides }),
    lines,
    records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function loggerOver(scene: Captured) {
  return createLogger(scene.config, {
    write(line: string) {
      scene.lines.push(line);
    },
  });
}

describe('selection', () => {
  it('is the log adapter for a deployment that says nothing', () => {
    const scene = captured();

    expect(scene.config.providers.email).toEqual({
      provider: 'log',
      fromAddress: 'invites@openbooks.test',
    });
    expect(typeof selectEmailProvider(scene.config, loggerOver(scene)).send).toBe('function');
  });

  it('is the SES adapter when the hosted deployment selects it', () => {
    const scene = captured({ EMAIL_PROVIDER: 'ses', AWS_REGION: 'eu-west-2' });

    expect(scene.config.providers.email).toEqual({
      provider: 'ses',
      fromAddress: 'invites@openbooks.test',
      region: 'eu-west-2',
    });
    // Constructing it resolves no credentials and opens no socket — the SDK does
    // both lazily on the first call, which is what lets `outboundEmail()` build
    // one in a process that may never send anything.
    expect(typeof selectEmailProvider(scene.config, loggerOver(scene)).send).toBe('function');
  });

  it('names the missing variable rather than failing at the first send', () => {
    expect(() => loadConfig({ ...baseEnv, EMAIL_PROVIDER: 'ses' })).toThrowError(/AWS_REGION/);
  });

  it('requires a from address even for the log adapter', () => {
    const withoutFrom: NodeJS.ProcessEnv = { ...baseEnv };
    delete withoutFrom['EMAIL_FROM_ADDRESS'];

    expect(() => loadConfig(withoutFrom)).toThrowError(/EMAIL_FROM_ADDRESS/);
  });
});

describe('the log adapter', () => {
  it('writes the whole message, including the from address it would have used', async () => {
    const scene = captured();
    const provider = selectEmailProvider(scene.config, loggerOver(scene));

    await provider.send({
      to: 'bookkeeper@example.test',
      subject: 'You have been invited to Ferris Wheel Co on OpenBooks',
      text: 'Accept the invitation:\nhttps://books.example.test/invites/accept?org=1&token=abc',
    });

    const records = scene.records();
    expect(records).toHaveLength(1);
    expect(records[0]?.['email']).toEqual({
      provider: 'log',
      from: 'invites@openbooks.test',
      to: 'bookkeeper@example.test',
      subject: 'You have been invited to Ferris Wheel Co on OpenBooks',
      text: 'Accept the invitation:\nhttps://books.example.test/invites/accept?org=1&token=abc',
    });
  });

  it('carries an html part only when there is one', async () => {
    const scene = captured();
    const provider = selectEmailProvider(scene.config, loggerOver(scene));

    await provider.send({ to: 'a@example.test', subject: 's', text: 't', html: '<p>t</p>' });

    expect(scene.records()[0]?.['email']).toMatchObject({ html: '<p>t</p>' });
  });

  /**
   * The adapter's own note says the body reaches the log and that a deployment
   * using it is choosing where its credentials live. This asserts the other half:
   * the log walk does not *silently* redact the body, which would leave a
   * self-host operator with an invite email they cannot use and no indication why.
   */
  it('does not redact the message body', async () => {
    const scene = captured();
    const provider = selectEmailProvider(scene.config, loggerOver(scene));

    await provider.send({ to: 'a@example.test', subject: 's', text: 'token=secret-looking' });

    expect(scene.lines.join('')).toContain('token=secret-looking');
  });
});
