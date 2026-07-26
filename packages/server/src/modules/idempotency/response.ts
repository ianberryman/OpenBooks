import { fromMinorUnits, toMinorString } from '@openbooks/shared-types';

import type { JsonValue } from '../../errors';
import { InternalError } from '../../errors';

/**
 * Turning an operation's return value into what the `response_body` JSON column
 * holds (migration `0003_idempotency`).
 *
 * ## Money in a JSON column
 *
 * `Money` is a branded `bigint` of minor units and `JSON.stringify` throws on
 * `bigint` — the logging module hit this already and solved it the same way
 * (`src/logging/serialize.ts`). Here it is not a logging inconvenience: the
 * stringify happens *inside the guarded transaction*, so an unconverted amount
 * anywhere in a response would roll back a write that had already succeeded.
 *
 * Money is stored as a **decimal string of minor units**, which is not a decision
 * this module gets to make — it is already the wire contract. `money.ts` states it
 * at length: a JSON *number* is an IEEE-754 double in every mainstream parser, so
 * any amount above 2^53 minor units loses precision on the way out and clients
 * reformat what they round-trip. Spec §12 admits no float on a money path, and a
 * JSON number is the one place where "no float" would be surrendered to somebody
 * else's parser. Rendering goes through `toMinorString` rather than a bare
 * `.toString()` so the money contract is named at the point of use; a non-money
 * `bigint` (a `BIGINT` surrogate key) renders to the identical decimal string.
 *
 * ## Why the first response is the normalized value, not the caller's object
 *
 * `runIdempotent` returns this normalized body on first execution too, rather than
 * passing the operation's own return value through. Otherwise the first response
 * and the replay would differ in exactly the cases that matter — a first response
 * carrying `9007199254740993n` and a replay carrying `"9007199254740993"` — and a
 * client comparing them would conclude the retry did something different. One
 * conversion, applied once, on both paths.
 *
 * The one residual difference is not ours: MySQL's `JSON` type normalizes on
 * storage, so a replayed object's keys may come back in a different order than they
 * went in. Deep equality holds, byte equality does not, and no JSON consumer is
 * entitled to key order. Tests assert deep equality for that reason.
 *
 * ## Permissive here, strict in `fingerprint.ts`
 *
 * This walk mirrors `JSON.stringify` semantics (own enumerable properties, absent
 * `undefined`, `toJSON` honoured for `Date`) rather than rejecting anything it does
 * not recognise. A response body is *our* DTO, and refusing to store one would fail
 * a write that has already been validated and applied. A request body is hashed
 * into a correctness decision, so that walk rejects instead of guessing.
 */

/** SQL NULL in `response_body`. See `normalizeResponseBody`. */
const EMPTY_BODY: JsonValue = null;

/**
 * Normalizes an operation's return value to the JSON form that is both stored and
 * returned.
 *
 * `undefined` becomes `null`. A body-less response (a 204) and a `null` body are
 * therefore the same stored state, which they have to be: mysql2 returns SQL NULL
 * and JSON `null` as the same JavaScript `null`, so the distinction could not
 * survive a replay even if it were preserved on write. The status carries it.
 */
export function normalizeResponseBody(value: unknown): JsonValue {
  return normalize(value, new Set<object>(), '$');
}

/**
 * The text bound to the `JSON` column. Separate from `normalizeResponseBody` so the
 * value returned to the caller and the value written to the row are provably the
 * same object.
 *
 * `JSON.stringify` cannot throw here: normalization has already removed every
 * `bigint`, and a non-finite number was rejected rather than silently emitted as
 * `null`.
 */
export function serializeResponseBody(body: JsonValue): string {
  return JSON.stringify(body);
}

/**
 * The select type of a `JSON` column is `kysely-codegen`'s `JsonValue`, whose object
 * form admits `undefined` property values. JSON parsing cannot produce one, so the
 * two types describe the same runtime values and this narrows away an unreachable
 * case. Confined to one function so it is the only place the read path asserts
 * anything about the column.
 */
export function readStoredResponseBody(stored: unknown): JsonValue {
  return stored === null || stored === undefined ? EMPTY_BODY : (stored as JsonValue);
}

function normalize(value: unknown, active: Set<object>, path: string): JsonValue {
  switch (typeof value) {
    case 'undefined':
      return EMPTY_BODY;
    case 'boolean':
    case 'string':
      return value;
    case 'number':
      return normalizeNumber(value, path);
    case 'bigint':
      return toMinorString(fromMinorUnits(value));
    case 'object':
      return normalizeObject(value, active, path);
    case 'symbol':
    case 'function':
      // `JSON.stringify` drops both from objects and turns a top-level one into
      // `undefined`. Dropping part of a response body silently would make the replay
      // disagree with the first response, so it is a fault.
      throw new InternalError(
        `Cannot store a ${typeof value} at ${path} in an idempotent response body.`,
      );
  }
}

function normalizeNumber(value: number, path: string): JsonValue {
  if (!Number.isFinite(value)) {
    // `JSON.stringify` writes `null` here. A silent null in a stored response is
    // the sort of thing that is discovered from a client's bug report.
    throw new InternalError(
      `Cannot store the non-finite number at ${path} in an idempotent response body. ` +
        'JSON has no representation for NaN or Infinity.',
    );
  }
  return value;
}

function normalizeObject(value: object | null, active: Set<object>, path: string): JsonValue {
  if (value === null) return null;
  if (active.has(value)) {
    throw new InternalError(`Cannot store a circular response body (cycle reached at ${path}).`);
  }

  active.add(value);
  try {
    if (value instanceof Date) return normalizeDate(value, path);

    // Rejected rather than serialized. `Buffer.toJSON()` yields
    // `{ type: 'Buffer', data: [...] }` and a bare `Uint8Array` yields
    // `{ "0": 1, ... }` — both mean a raw `BINARY(16)` identifier escaped into a
    // response instead of the UUID string spec §4 requires on the wire. Storing
    // that would make the bug permanent for the retention window.
    if (value instanceof Uint8Array) {
      throw new InternalError(
        `Cannot store binary data at ${path} in an idempotent response body. Identifiers ` +
          'cross the wire as UUID strings (spec §4), never as BINARY(16).',
      );
    }

    if (Array.isArray(value)) {
      return (value as readonly unknown[]).map((item, index) =>
        normalize(item, active, `${path}[${index}]`),
      );
    }

    const result: Record<string, JsonValue> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      // Absent, not null — `JSON.stringify` omits undefined properties, and a
      // response DTO with an optional field left unset should read as unset.
      if (nested === undefined) continue;
      result[key] = normalize(nested, active, `${path}.${key}`);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function normalizeDate(value: Date, path: string): JsonValue {
  if (Number.isNaN(value.getTime())) {
    throw new InternalError(`Cannot store an invalid Date at ${path}.`);
  }
  return value.toISOString();
}
