import { createHash } from 'node:crypto';

import { InternalError } from '../../errors';

/**
 * Request fingerprints (spec §12; migration `0003_idempotency`).
 *
 * `request_fingerprint` is what makes a replay *safe* rather than merely
 * deduplicated. Returning the first request's response to a second, *different*
 * request that reused the key is silent data loss — the client believes its second
 * write happened. So the hash has exactly one job: two requests must hash the same
 * **iff** they are the same request. Both directions carry a cost when broken.
 *
 *  - **Same request, different encoding → same hash**, or a legitimate retry
 *    becomes a spurious 409. JSON object key order is not preserved anywhere in the
 *    path — not by HTTP, not by a client that rebuilds its retry body from an
 *    object, not by MySQL's `JSON` type — so key order must not affect the hash.
 *  - **Different requests → different hashes**, or a genuinely different request is
 *    answered from cache. This is the dangerous direction, and it is why the
 *    encoding below is type-tagged and length-prefixed instead of `JSON.stringify`
 *    over a key-sorted copy.
 *
 * ## Why not `JSON.stringify` with sorted keys
 *
 * Three reasons, in increasing order of weight.
 *
 * 1. It throws on `bigint`. Money is a branded `bigint` end to end (OB-005), so an
 *    amount anywhere in a request body would take the write down rather than
 *    fingerprint it.
 * 2. It erases distinctions the request genuinely has. `{ a: 1 }`, `{ a: '1' }` and
 *    `{ a: 1n }` are three different requests; JSON collapses the first and third
 *    and, once quotes are the only difference, a hash over the text is one typo in
 *    a schema away from collapsing all three.
 * 3. Concatenating keys is delimiter-ambiguous. `{ 'a:b': 1 }` and `{ a: ':b:1' }`
 *    are distinguishable only if strings carry their own length, which is why every
 *    string here is written as `s<length>:<value>` and every container as
 *    `<tag><count>:`. The encoding is self-delimiting, so nothing needs separators
 *    and no value can be forged by choosing clever content.
 *
 * ## Key ordering
 *
 * Object keys are sorted by UTF-16 code unit, ascending, before encoding, and
 * arrays keep their order — array order is semantic (journal line order), object
 * key order is not. The comparator is written out rather than left to
 * `Array.prototype.sort()`'s default: the default is also code-unit order, but a
 * bare `.sort()` on strings reads as though it might be locale-sensitive, and a
 * locale-dependent fingerprint would mean two API replicas disagreeing about
 * whether a retry is a retry.
 *
 * ## Scheme version
 *
 * `SCHEME` is mixed into every hash so a change to this encoding is visible rather
 * than mysterious. It does not make such a change safe: fingerprints already
 * stored keep the old scheme's value, so any key claimed within the retention
 * window before a deploy that changes the encoding will 409 on retry. That fails
 * closed — a spurious 409 tells the client to regenerate a key, where a spurious
 * *match* would double-post — and if it ever needs to be seamless the answer is a
 * scheme column and a two-way comparison, not a silent rehash.
 */

/** Bumped only alongside a deliberate change to `canonicalize`. See above. */
const SCHEME = 'ob-idem-v1';

/**
 * Hex SHA-256 over the canonical encoding, sized for the `CHAR(64)` column.
 *
 * The endpoint is part of the hashed input as well as its own column. One
 * `CHAR(64)` comparison then decides the whole question, so there is no way to
 * check the body and forget the endpoint; the column stays because an operator
 * reading the table wants to know which route a key belongs to without reversing a
 * hash.
 */
export function requestFingerprint(endpoint: string, request: unknown): string {
  const canonical = SCHEME + canonicalize(endpoint) + canonicalize(request);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Exported for its own test; the fingerprint is the only production caller. */
export function canonicalize(value: unknown): string {
  return encode(value, new Set<object>(), '$');
}

function encode(value: unknown, active: Set<object>, path: string): string {
  switch (typeof value) {
    case 'undefined':
      return 'u';
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'number':
      return encodeNumber(value, path);
    case 'bigint':
      return `i${value.toString()}`;
    case 'string':
      return encodeString(value);
    case 'object':
      return encodeObject(value, active, path);
    case 'symbol':
    case 'function':
      // `JSON.stringify` drops both, which would make two different requests hash
      // the same — the one outcome this must not allow.
      throw unsupported(typeof value, path);
  }
}

function encodeString(value: string): string {
  return `s${value.length}:${value}`;
}

function encodeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new InternalError(
      `Cannot fingerprint a non-finite number at ${path}. JSON has no representation for ` +
        'NaN or Infinity, so one cannot have arrived in a validated request body.',
    );
  }
  // `toString()` is the shortest round-tripping decimal, so two numbers encode
  // identically exactly when they are `===`. The single exception is -0, which
  // encodes as "0" — the same collapse JSON performs, and not a distinction any
  // request body carries meaning in.
  return `n${value === 0 ? '0' : value.toString()}`;
}

function encodeObject(value: object | null, active: Set<object>, path: string): string {
  if (value === null) return 'z';
  if (active.has(value)) {
    throw new InternalError(`Cannot fingerprint a circular request at ${path}.`);
  }

  active.add(value);
  try {
    if (value instanceof Date) return encodeDate(value, path);
    if (Array.isArray(value)) {
      const items = (value as readonly unknown[]).map((item, index) =>
        encode(item, active, `${path}[${index}]`),
      );
      return `a${items.length}:${items.join('')}`;
    }

    // Strict about shape, unlike `normalizeResponseBody` in `response.ts`, and the
    // asymmetry is deliberate. A request body is Zod-validated wire JSON, so a
    // `Map`, a `Set`, a `Buffer`, or a class instance means the wrapper was handed
    // something other than the request — and the failure mode of guessing is a
    // fingerprint over a value the encoding cannot see, i.e. two different requests
    // that collide. A response body has no such guarantee to lean on and is not
    // security-relevant, so that walk is permissive instead.
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw unsupported(constructorNameOf(value), path);
    }

    // `Object.entries` yields string keys only. A symbol-keyed property would be
    // invisible here — and equally invisible to JSON, to Zod, and to the wire, so
    // there is no request in which one is part of the payload.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    const encoded = entries.map(
      ([key, nested]) => encodeString(key) + encode(nested, active, `${path}.${key}`),
    );
    return `o${encoded.length}:${encoded.join('')}`;
  } finally {
    active.delete(value);
  }
}

function encodeDate(value: Date, path: string): string {
  if (Number.isNaN(value.getTime())) {
    throw new InternalError(`Cannot fingerprint an invalid Date at ${path}.`);
  }
  return `d${value.toISOString()}`;
}

function constructorNameOf(value: object): string {
  const name: unknown = (value as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === 'string' ? name : 'object';
}

function unsupported(description: string, path: string): InternalError {
  return new InternalError(
    `Cannot fingerprint a ${description} at ${path}. The value handed to the idempotency ` +
      'wrapper must be the validated request payload — plain objects, arrays, strings, ' +
      'numbers, bigints, booleans, null, and Date.',
  );
}
