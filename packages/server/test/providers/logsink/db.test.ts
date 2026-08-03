import type { LogRecord } from '@openbooks/plugin-api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../../src/db';
import { createDbLogSink } from '../../../src/providers/logsink/db';
import { useTestDatabase } from '../../db';

/**
 * The `db` `LogSinkProvider` against real MySQL (spec §11 — never mocks). The
 * *process* database handle has to be initialized alongside the harness's own
 * pools: `createDbLogSink` reaches `logs` through `systemDb()`, which reads the
 * module-private client in `src/db/client.ts` (the same reason
 * `test/accounts/support.ts`'s `useServiceDatabase` exists) — pointing that client
 * at the harness container is what makes this a statement about the production
 * path, not a second query written for the test.
 */
const harness = useTestDatabase();

beforeAll(() => {
  if (!isDatabaseInitialized()) initializeDatabase(harness.appConnectionConfig);
});

afterAll(async () => {
  await destroyDatabase();
});

interface LogRow {
  readonly id: Buffer;
  readonly level: string;
  readonly role: string;
  readonly message: string;
  readonly org_id: Buffer | null;
  readonly fields: unknown;
}

async function readLogs(migrator: (typeof harness)['migrator']): Promise<LogRow[]> {
  const rows = await migrator
    .selectFrom('logs')
    .select(['id', 'level', 'role', 'message', 'org_id', 'fields'])
    .orderBy('logged_at', 'asc')
    .execute();
  // `fields` is a JSON column; mysql2 parses it back into a JS value on SELECT
  // (the same behaviour `event_log.payload` reads rely on — `event-outbox-
  // support.ts`'s `readEventLog`), so no `JSON.parse` is needed on the way out.
  return rows;
}

describe('createDbLogSink', () => {
  it('inserts a batch, round-tripping level/role/message/org_id/fields', async () => {
    const org = await harness.factories.org();
    const sink = createDbLogSink();

    const withOrg: LogRecord = {
      at: new Date('2026-01-15T12:00:00.000Z').toISOString(),
      level: 'warn',
      role: 'api',
      message: 'rate limit approaching',
      orgId: org.uuid,
      fields: { requestId: 'req-1', attempt: 3 },
    };
    const withoutOrg: LogRecord = {
      at: new Date('2026-01-15T12:00:01.000Z').toISOString(),
      level: 'info',
      role: 'migrate',
      message: 'migration 0026 applied',
      orgId: null,
      fields: {},
    };

    await sink.write([withOrg, withoutOrg]);

    const rows = await readLogs(harness.migrator);
    expect(rows).toHaveLength(2);

    const [first, second] = rows;
    expect(first).toMatchObject({
      level: 'warn',
      role: 'api',
      message: 'rate limit approaching',
    });
    expect(first!.org_id).toBeInstanceOf(Buffer);
    // The BINARY(16) form of the org uuid the record named — proves the string
    // orgId was converted through `tryUuidToBuffer`, not stored as raw text.
    expect(first!.org_id).toEqual(org.id);
    expect(first!.fields).toEqual({ requestId: 'req-1', attempt: 3 });

    expect(second).toMatchObject({
      level: 'info',
      role: 'migrate',
      message: 'migration 0026 applied',
    });
    expect(second!.org_id).toBeNull();
    expect(second!.fields).toEqual({});
  });

  it('is a no-op for an empty batch', async () => {
    const sink = createDbLogSink();
    await sink.write([]);

    const rows = await readLogs(harness.migrator);
    expect(rows).toHaveLength(0);
  });
});
