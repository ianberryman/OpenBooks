import type { EmailProvider } from '@openbooks/plugin-api';
import { afterEach, beforeAll, afterAll } from 'vitest';

import { loadConfig } from '../../src/config';
import { createRequestContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { createLogger } from '../../src/logging';
import { selectEmailProvider, setOutboundEmail } from '../../src/providers';
import type { SystemRoleName, TestDatabase, UserFixture } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-040 suites.
 *
 * These exercise the real services, so the *process* database handle is
 * initialized as well as the harness's own pools: the members repository reaches
 * data through `tenantDb()`, which consults the module-private client in
 * `src/db/client.ts`. Pointing that client at the harness container is what makes
 * these tests statements about the production path.
 *
 * `useServiceDatabase`, `contextFor`, and `actorIn` duplicate
 * `test/accounts/support.ts`, which itself notes the duplication and the reason:
 * they want to be one `test/support/service.ts`, and no single ticket owns the
 * suites that would have to move. This is the fourth copy. Someone should hoist
 * them.
 *
 * `captureEmail` is the part that is new, and it is not a mock (spec §11). It
 * builds the *real* `log` adapter through the *real* provider selection, over a
 * pino logger writing to an in-memory stream, so an invite test reads its token
 * out of the message the system actually produced — which means these tests also
 * prove that the link a recipient receives is a link that works.
 */
export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly user: UserFixture;
  readonly ctx: RequestContext;
}

/** An org, a member holding one of the six seeded roles, and a context for the pair. */
export async function actorIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
  user?: UserFixture,
): Promise<ActorFixture> {
  const org = await db.factories.org();
  return memberOf(db, org.id, org.uuid, role, user);
}

/** A second (third, fourth) member of an org that already exists. */
export async function memberOf(
  db: TestDatabase,
  orgId: Buffer,
  orgUuid: string,
  role: SystemRoleName = 'owner',
  user?: UserFixture,
): Promise<ActorFixture> {
  const member = user ?? (await db.factories.user());
  await db.factories.orgMember({ orgId, userId: member.id, roleId: systemRoleId(role) });

  return {
    orgUuid,
    orgId,
    user: member,
    ctx: contextFor(orgUuid, SYSTEM_ROLE_UUIDS[role], member.uuid),
  };
}

/** The `from` address every captured message is sent as. */
export const TEST_FROM_ADDRESS = 'invites@openbooks.test';

/** The origin captured invite links are built against. */
export const TEST_APP_BASE_URL = 'https://books.example.test';

export interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly from: string;
}

export interface EmailCapture {
  /** Every message the adapter wrote, in order. */
  readonly sent: () => readonly SentEmail[];
  /** The one message sent to `address`, or a thrown error naming what was sent. */
  readonly to: (address: string) => SentEmail;
  /** The raw NDJSON, for asserting a string is or is not anywhere in the log. */
  readonly log: () => string;
  /**
   * Re-installs this capture as the process-wide outbound email.
   *
   * For the one test that swaps in a failing provider and has to put the capture
   * back: `captureEmail()` itself registers Vitest hooks, and hooks may only be
   * registered during collection, so calling it again from inside a test is not
   * the way to restore anything.
   */
  readonly install: () => void;
  /**
   * Swaps the provider while keeping this capture's logger, for the tests that
   * need a send to fail. Undone by the `afterEach` that re-installs.
   */
  readonly withProvider: (provider: EmailProvider) => void;
}

/**
 * Installs the real `log` email adapter over a capture stream for one test file.
 *
 * The env below is a whole environment because `loadConfig` validates one —
 * selection is the thing under test, so the provider is chosen the way a
 * deployment chooses it (`EMAIL_PROVIDER` unset means the self-host default,
 * which OB-040 makes `log`) rather than by constructing the adapter directly.
 */
export function captureEmail(env: NodeJS.ProcessEnv = {}): EmailCapture {
  const lines: string[] = [];

  const config = loadConfig({
    OPENBOOKS_ROLE: 'api',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    DATABASE_HOST: 'unused',
    DATABASE_USER: 'unused',
    DATABASE_PASSWORD: 'unused',
    DATABASE_NAME: 'unused',
    SESSION_SECRET: 's'.repeat(40),
    STORAGE_LOCAL_PATH: '/tmp/openbooks-test',
    EMAIL_FROM_ADDRESS: TEST_FROM_ADDRESS,
    APP_BASE_URL: TEST_APP_BASE_URL,
    // The self-host default SECRETS_PROVIDER is `local` (initiative J, D-101).
    SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
    ...env,
  });

  const logger = createLogger(config, {
    write(line: string) {
      lines.push(line);
    },
  });

  const base = {
    logger,
    ...(config.appBaseUrl === undefined ? {} : { appBaseUrl: config.appBaseUrl }),
  };
  const outbound = { ...base, provider: selectEmailProvider(config, logger) };
  const install = (): void => {
    setOutboundEmail(outbound);
  };
  const withProvider = (provider: EmailProvider): void => {
    // The capture's own logger, so a send that fails is still observable here —
    // the failure log is part of what "never fails the write" has to prove.
    setOutboundEmail({ ...base, provider });
  };
  install();

  // Cleared and re-installed between tests, so one test's invite cannot be read by
  // the next and a test that swapped the provider out cannot leak it forward.
  // Uninstalled at the end so a later suite gets the process default back.
  afterEach(() => {
    lines.length = 0;
    install();
  });
  afterAll(() => {
    setOutboundEmail(undefined);
  });

  const sent = (): readonly SentEmail[] =>
    lines
      .map((line) => JSON.parse(line) as { email?: SentEmail })
      .flatMap((record) => (record.email === undefined ? [] : [record.email]));

  return {
    sent,
    to: (address) => {
      const match = sent().filter((message) => message.to === address);
      if (match.length !== 1) {
        throw new Error(
          `Expected exactly one message to ${address}, found ${String(match.length)}. ` +
            `Messages sent: ${JSON.stringify(sent().map((message) => message.to))}`,
        );
      }
      return match[0] as SentEmail;
    },
    log: () => lines.join(''),
    install,
    withProvider,
  };
}

/**
 * The token out of a real invite email.
 *
 * Parsed from the link rather than returned by the service, because the service
 * deliberately never returns it — the token exists in plaintext once, in the
 * message. A test that could get it any other way would be testing a different
 * system.
 */
export function tokenFrom(message: SentEmail): string {
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(message.text);
  if (match?.[1] === undefined) {
    throw new Error(`No invite token in the message body:\n${message.text}`);
  }
  return match[1];
}

/** The org id out of the same link, so a test can accept the way a recipient would. */
export function orgFrom(message: SentEmail): string {
  const match = /[?&]org=([0-9a-fA-F-]+)/.exec(message.text);
  if (match?.[1] === undefined) {
    throw new Error(`No org id in the message body:\n${message.text}`);
  }
  return match[1];
}

/**
 * An `EmailProvider` that always fails. Fault injection, not a mock: it is a real
 * implementation of the interface whose behaviour is the failure being tested, and
 * nothing asserts that it was called.
 */
export function failingEmailProvider(error: Error): EmailProvider {
  return {
    send() {
      return Promise.reject(error);
    },
  };
}
