import { randomUUID } from 'node:crypto';

/**
 * UUID ↔ `BINARY(16)` conversion, in the byte order the schema uses.
 *
 * Client-facing identifiers are UUIDs stored as `BINARY(16)` (spec §4) in *plain*
 * hex byte order — `UUID_TO_BIN(x, 0)`, never `UUID_TO_BIN(x, 1)`. The migrations
 * README explains the choice: the swapped form only buys index locality for
 * time-ordered UUIDv1, and these are random v4.
 *
 * The reason this lives in its own module with its own test is that getting it
 * wrong is silent. A swapped encoding still produces 16 valid bytes, still
 * inserts, still round-trips through *this* codebase, and only disagrees with the
 * database's own `UUID_TO_BIN` / `BIN_TO_UUID` — so it surfaces as a row that
 * cannot be found by a UUID that provably wrote it. `uuid.test.ts` asserts the
 * agreement against a live MySQL rather than against these functions themselves.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UUID_BYTES = 16;

export function newUuid(): string {
  return randomUUID();
}

export function newUuidBuffer(): Buffer {
  return uuidToBuffer(randomUUID());
}

export function uuidToBuffer(uuid: string): Buffer {
  if (!UUID_PATTERN.test(uuid)) {
    throw new TypeError(`Not a UUID: ${JSON.stringify(uuid)}`);
  }
  return Buffer.from(uuid.replaceAll('-', ''), 'hex');
}

export function bufferToUuid(value: Buffer): string {
  if (value.length !== UUID_BYTES) {
    throw new TypeError(`BINARY(16) expected, got ${value.length} byte(s)`);
  }
  const hex = value.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
