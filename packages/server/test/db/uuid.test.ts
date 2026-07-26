import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { useTestDatabase } from './harness';
import { bufferToUuid, newUuid, uuidToBuffer } from './uuid';

/**
 * The UUID encoding, checked against the database rather than against itself.
 *
 * `BINARY(16)` UUIDs are plain hex byte order — `UUID_TO_BIN(x, 0)` (spec §4, and
 * the migrations README on why not the byte-swapped form). A JS implementation that
 * swaps the time fields produces 16 perfectly valid bytes and round-trips through
 * its own inverse without complaint; the only thing that catches it is comparing to
 * MySQL's own conversion. `0001_tenancy` seeds the system role IDs with
 * `UUID_TO_BIN(..., 0)`, so a disagreement here means the harness cannot find rows
 * the migration wrote.
 */
describe('UUID BINARY(16) encoding', () => {
  const db = useTestDatabase();

  // Every byte distinct, so a swap of any field group changes the value. A random
  // v4 would not necessarily reveal a reordering.
  const PROBE = '00112233-4455-6677-8899-aabbccddeeff';

  it('is a pure hex decode, not the byte-swapped form', () => {
    expect(uuidToBuffer(PROBE).toString('hex')).toBe('00112233445566778899aabbccddeeff');
  });

  it('round-trips in JavaScript', () => {
    const uuid = newUuid();
    expect(bufferToUuid(uuidToBuffer(uuid))).toBe(uuid);
  });

  it('agrees with UUID_TO_BIN(x, 0)', async () => {
    const { rows } = await sql<{ bin: Buffer }>`SELECT UUID_TO_BIN(${PROBE}, 0) AS bin`.execute(
      db.app,
    );

    expect(rows[0]!.bin.equals(uuidToBuffer(PROBE))).toBe(true);
  });

  it('agrees with BIN_TO_UUID(b, 0)', async () => {
    const { rows } = await sql<{ text: string }>`
      SELECT BIN_TO_UUID(${uuidToBuffer(PROBE)}, 0) AS text
    `.execute(db.app);

    expect(rows[0]!.text).toBe(PROBE);
  });

  it('disagrees with the swapped form, which is what makes the check meaningful', async () => {
    const { rows } = await sql<{ bin: Buffer }>`SELECT UUID_TO_BIN(${PROBE}, 1) AS bin`.execute(
      db.app,
    );

    expect(rows[0]!.bin.equals(uuidToBuffer(PROBE))).toBe(false);
  });

  it('round-trips through a BINARY(16) column', async () => {
    const org = await db.factories.org();
    const row = await db.app
      .selectFrom('orgs')
      .select(['id', sql<string>`BIN_TO_UUID(id, 0)`.as('uuid')])
      .where('id', '=', uuidToBuffer(org.uuid))
      .executeTakeFirstOrThrow();

    expect(row.uuid).toBe(org.uuid);
    expect(bufferToUuid(row.id)).toBe(org.uuid);
  });

  it('rejects values that are not UUIDs or not 16 bytes', () => {
    expect(() => uuidToBuffer('not-a-uuid')).toThrow(TypeError);
    expect(() => bufferToUuid(Buffer.alloc(8))).toThrow(TypeError);
  });
});
