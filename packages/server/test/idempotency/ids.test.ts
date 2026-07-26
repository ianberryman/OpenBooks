import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { InternalError } from '../../src/errors';
import { newIdBuffer, uuidToBuffer } from '../../src/modules/idempotency/ids';
import { useTestDatabase } from '../db/harness';
import { newUuid, uuidToBuffer as harnessUuidToBuffer } from '../db/uuid';

/**
 * `src/modules/idempotency/ids.ts` duplicates eleven lines of `test/db/uuid.ts`
 * because `src/` has no shared UUID conversion and this ticket may not add one
 * outside its own directory. A duplicated encoder is only safe if it is pinned to
 * the same authority, and the authority is MySQL: a byte-swapped encoding still
 * produces 16 valid bytes and still round-trips through this codebase, disagreeing
 * only with the database's own `BIN_TO_UUID`. So this asserts against the server,
 * not against the other copy — and then against the other copy too, so the day the
 * two are merged the merge is provably a no-op.
 */
describe('claim identifiers', () => {
  const db = useTestDatabase();

  it('encodes UUIDs the way MySQL does with UUID_TO_BIN(x, 0)', async () => {
    const uuid = newUuid();

    const { rows } = await sql<{ bin: Buffer }>`SELECT UUID_TO_BIN(${uuid}, 0) AS bin`.execute(
      db.app,
    );

    expect(uuidToBuffer(uuid)).toEqual(rows[0]!.bin);
  });

  it('agrees with the harness copy, which is itself checked against MySQL', () => {
    const uuid = newUuid();

    expect(uuidToBuffer(uuid)).toEqual(harnessUuidToBuffer(uuid));
  });

  it('mints distinct 16-byte identifiers', () => {
    const ids = new Set(Array.from({ length: 64 }, () => newIdBuffer().toString('hex')));

    expect(ids.size).toBe(64);
    expect(newIdBuffer()).toHaveLength(16);
  });

  it('treats a malformed identifier as an internal fault, not client input', () => {
    // The only UUID this converts is `context.orgId`, which came from a row the
    // session layer read. A bad one is a wiring bug, so it maps to 500.
    expect(() => uuidToBuffer('not-a-uuid')).toThrow(InternalError);
  });
});
