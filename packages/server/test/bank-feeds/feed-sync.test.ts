import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLocalSecretsProvider, setSecretsProvider } from '../../src/providers';
import {
  connectBankFeed,
  deactivateBankFeed,
  getBankFeed,
  syncBankFeed,
} from '../../src/modules/bank-feeds';
import type { Scene } from '../banking/support';
import { linesOf, sceneIn, useServiceDatabase, withContext } from '../banking/support';
import { uuidToBuffer } from '../db';

/**
 * The live-feed ingest (OB-227), proved against the deterministic `fake` provider
 * (D-102): connecting a feed, pulling it into `bank_statement_lines`, and — the two
 * claims worth pinning — that a re-sync writes nothing, by *either* of the two
 * independent mechanisms that guarantee it.
 *
 * The `fake` returns a fixed batch of three transactions on the first pull
 * (`cursor: null`) and nothing on any later cursor, so the suite can drive both:
 *   - **D-128, the cursor.** A second sync fetches from the advanced cursor, so the
 *     provider returns an empty batch — nothing is even read.
 *   - **D-127, the fingerprint.** Rewind the cursor to `null` and the provider yields
 *     the *same* three transactions again; they are read but the unique key collapses
 *     them, so zero are written. This is the guarantee that survives a provider that
 *     replays, which a cursor alone would not catch.
 *
 * Cross-org 404 and the `banking.connect`/`banking.import` gates are asserted in the
 * enforcement suites; this is the behaviour.
 */

const db = useServiceDatabase();
let scene: Scene;

const EXTERNAL_ACCOUNT_ID = 'fc-acct-1';

// `connectBankFeed`/`loadConnectionProvider` reach the secrets provider and the
// process-wide `getConfig()` (for `appBaseUrl`), which `useServiceDatabase` does not
// stand up. Installed directly the way `payments-processing`'s harness does — filling
// only the config env gaps (`??=`) so a real environment is never overridden.
const CONFIG_ENV_FALLBACKS: Readonly<Record<string, string>> = {
  DATABASE_HOST: 'unused',
  DATABASE_USER: 'unused',
  DATABASE_PASSWORD: 'unused',
  DATABASE_NAME: 'unused',
  SESSION_SECRET: 's'.repeat(40),
  STORAGE_LOCAL_PATH: '/tmp/openbooks-test-bank-feeds',
  EMAIL_FROM_ADDRESS: 'tests@example.invalid',
  SECRETS_ENCRYPTION_KEY: 'k'.repeat(32),
};

beforeAll(() => {
  for (const [key, value] of Object.entries(CONFIG_ENV_FALLBACKS)) process.env[key] ??= value;
  setSecretsProvider(
    createLocalSecretsProvider({ provider: 'local', encryptionKey: 'k'.repeat(32) }),
  );
});

afterAll(() => {
  setSecretsProvider(undefined);
});

beforeEach(async () => {
  scene = await sceneIn(db);
});

function connect() {
  return withContext(scene.ctx, () =>
    connectBankFeed(
      {
        bankAccountId: scene.bankAccountUuid,
        feedSource: 'fake',
        restrictedKey: 'rk_test_behaviour',
        externalAccountId: EXTERNAL_ACCOUNT_ID,
      },
      scene.ctx,
    ),
  );
}

function sync(connectionId: string) {
  return withContext(scene.ctx, () => syncBankFeed(connectionId, scene.ctx));
}

async function rewindCursor(connectionId: string): Promise<void> {
  await db.app
    .updateTable('bank_feed_connections')
    .set({ sync_cursor: null })
    .where('id', '=', uuidToBuffer(connectionId))
    .execute();
}

async function bankReferencesOf(): Promise<string[]> {
  const rows = await db.app
    .selectFrom('bank_statement_lines')
    .select('bank_reference')
    .where('bank_account_id', '=', scene.bankAccountId)
    .orderBy('bank_reference')
    .execute();
  return rows.map((row) => row.bank_reference ?? '');
}

describe('connecting a live feed', () => {
  it('flips the bank account to the feed source, and disconnecting reverts it to file', async () => {
    const connection = await connect();
    expect(connection.feedSource).toBe('fake');
    expect(connection.isActive).toBe(true);

    const account = await db.app
      .selectFrom('bank_accounts')
      .select('feed_source')
      .where('id', '=', scene.bankAccountId)
      .executeTakeFirstOrThrow();
    expect(account.feed_source).toBe('fake');

    const disconnected = await withContext(scene.ctx, () =>
      deactivateBankFeed(connection.id, scene.ctx),
    );
    expect(disconnected.isActive).toBe(false);

    const reverted = await db.app
      .selectFrom('bank_accounts')
      .select('feed_source')
      .where('id', '=', scene.bankAccountId)
      .executeTakeFirstOrThrow();
    expect(reverted.feed_source).toBe('file');
  });

  it('refuses a second feed on the same bank account', async () => {
    await connect();
    await expect(connect()).rejects.toThrow();
  });
});

describe('syncing a live feed', () => {
  it('lands the pulled transactions as append-only lines in the asset frame', async () => {
    const connection = await connect();

    const result = await sync(connection.id);
    expect(result.linesImported).toBe(3);
    expect(result.linesDuplicate).toBe(0);
    expect(result.cursor).toBe('cursor-1');

    const lines = await linesOf(db.app, scene.bankAccountId);
    expect(lines).toHaveLength(3);
    // The fake's fixed batch, in the asset frame (+ = money in, D-13): a deposit and
    // two payments out. Signed minor units, never a decimal.
    expect(lines.map((line) => line.amount_minor).sort((a, b) => Number(a - b))).toEqual([
      -90000n,
      -4200n,
      150000n,
    ]);
    // No file backs a feed line — the same NULL a hand-entered line carries (D-129).
    expect(lines.every((line) => line.import_id === null)).toBe(true);

    // D-127's anchor: the provider's stable transaction id rides into `bank_reference`.
    expect(await bankReferencesOf()).toEqual([
      `${EXTERNAL_ACCOUNT_ID}-txn-1`,
      `${EXTERNAL_ACCOUNT_ID}-txn-2`,
      `${EXTERNAL_ACCOUNT_ID}-txn-3`,
    ]);

    // The cursor advanced, and is visible on the connection (D-128).
    const after = await withContext(scene.ctx, () => getBankFeed(connection.id, scene.ctx));
    expect(after.lastSyncedAt).not.toBeNull();
  });

  it('D-128: a second sync reads nothing from the advanced cursor and writes nothing', async () => {
    const connection = await connect();
    await sync(connection.id);

    const again = await sync(connection.id);
    expect(again.linesImported).toBe(0);
    expect(again.linesDuplicate).toBe(0); // nothing was even read
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(3);
  });

  it('D-127: replaying the same transactions (cursor rewound) reads three but writes none', async () => {
    const connection = await connect();
    await sync(connection.id);

    // Force the provider to replay: the fake yields the same three transactions again
    // from a null cursor, so the fingerprint — not the cursor — is what must catch them.
    await rewindCursor(connection.id);

    const replay = await sync(connection.id);
    expect(replay.linesImported).toBe(0);
    expect(replay.linesDuplicate).toBe(3); // read three, wrote none
    expect(await linesOf(db.app, scene.bankAccountId)).toHaveLength(3);
  });
});
