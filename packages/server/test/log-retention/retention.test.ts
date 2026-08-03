import type { DestinationStream } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized, systemDb } from '../../src/db';
import { createLogger } from '../../src/logging';
import { runLogRetentionSweep } from '../../src/modules/log-retention';
import type { TestDatabase } from '../db';
import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * `runLogRetentionSweep` end to end (OB-255; ROADMAP D-255-3).
 *
 * Exercised directly rather than through `registerLogRetentionJob`/`queue.subscribe`,
 * the same reason `postOnePeriod`'s own suite gives: the daily tick and the queue
 * wiring are OB-127's, and this suite's job is the prune's own effect — rows older
 * than the window are gone, rows inside it are not, and a second run is a no-op.
 *
 * `useServiceDatabase` (`test/payments/support.ts`) is not reused here on purpose —
 * that file's own header explains why a suite duplicates the process-pool
 * initialization rather than reaching into another suite's support file.
 */

const baseEnv = {
  DATABASE_HOST: 'mysql',
  DATABASE_USER: 'openbooks_app',
  DATABASE_PASSWORD: 'app-password',
  DATABASE_NAME: 'openbooks',
  SESSION_SECRET: 'x'.repeat(32),
  STORAGE_LOCAL_PATH: '/var/lib/openbooks/storage',
  EMAIL_FROM_ADDRESS: 'openbooks@example.test',
  SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
} satisfies NodeJS.ProcessEnv;

const silentSink: DestinationStream = { write() {} };

function testLogger() {
  return createLogger(loadConfig({ ...baseEnv, NODE_ENV: 'test', LOG_LEVEL: 'trace' }), silentSink);
}

function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

async function insertLogRow(db: TestDatabase, loggedAt: Date, message: string): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('logs')
    .values({
      id,
      logged_at: loggedAt,
      level: 'info',
      role: 'api',
      message,
      org_id: null,
      fields: '{}',
    })
    .execute();
  return id;
}

async function logExists(db: TestDatabase, id: Buffer): Promise<boolean> {
  const row = await systemDb()
    .selectFrom('logs')
    .select('id')
    .where('id', '=', id)
    .executeTakeFirst();
  return row !== undefined;
}

describe('runLogRetentionSweep', () => {
  const db = useServiceDatabase();

  it('deletes rows older than the retention window and keeps the rest', async () => {
    const runDate = '2026-08-02';
    const retentionDays = 7;
    // Cutoff is 2026-07-26T00:00:00Z.
    const expired = await insertLogRow(db, new Date('2026-07-01T00:00:00Z'), 'old line');
    const stillFresh = await insertLogRow(db, new Date('2026-08-01T00:00:00Z'), 'recent line');

    await runLogRetentionSweep({ runDate }, { logger: testLogger(), retentionDays });

    expect(await logExists(db, expired)).toBe(false);
    expect(await logExists(db, stillFresh)).toBe(true);

    // A second run against the same cutoff finds nothing left to prune, and must
    // not throw — the sweep is idempotent, the way a retried daily tick requires.
    await expect(
      runLogRetentionSweep({ runDate }, { logger: testLogger(), retentionDays }),
    ).resolves.toBeUndefined();
    expect(await logExists(db, stillFresh)).toBe(true);
  });

  it('treats a row exactly at the cutoff as still inside the window', async () => {
    const runDate = '2026-08-02';
    const retentionDays = 7;
    // 2026-07-26T00:00:00Z is the cutoff itself; `<` must not delete it.
    const atCutoff = await insertLogRow(db, new Date('2026-07-26T00:00:00Z'), 'boundary line');

    await runLogRetentionSweep({ runDate }, { logger: testLogger(), retentionDays });

    expect(await logExists(db, atCutoff)).toBe(true);
  });

  it('never throws out of the sweep even if the retention window is degenerate', async () => {
    const runDate = '2026-08-02';
    const row = await insertLogRow(db, new Date('2026-08-01T00:00:00Z'), 'kept by a huge window');

    await expect(
      runLogRetentionSweep({ runDate }, { logger: testLogger(), retentionDays: 36_500 }),
    ).resolves.toBeUndefined();
    expect(await logExists(db, row)).toBe(true);
  });
});
