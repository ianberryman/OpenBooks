import { describe, expect, it } from 'vitest';

import { canonicalize, requestFingerprint } from '../../src/modules/idempotency';

/**
 * The fingerprint decides whether a retry is a retry (spec §12, OB-017).
 *
 * Two properties, and the tests are organized around them because the
 * consequences of breaking each are opposite:
 *
 *  - **Same request → same hash.** Breaking this turns legitimate retries into
 *    spurious `409`s. Annoying, and it fails closed.
 *  - **Different requests → different hashes.** Breaking this answers a *different*
 *    request from cache, which is silent data loss. So the collision cases below
 *    are the load-bearing half, and they are exhaustive about the ways a naive
 *    encoding collides: type erasure, delimiter ambiguity, and array order.
 *
 * `canonicalize` is asserted through rather than around: comparing canonical
 * strings makes a failure legible (you can read what the encoder produced), where
 * comparing hex digests only tells you two things differ.
 */

const ENDPOINT = 'journals.post';

function fingerprintOf(request: unknown, endpoint = ENDPOINT): string {
  return requestFingerprint(endpoint, request);
}

describe('the same request always fingerprints the same', () => {
  it('does not depend on object key order', () => {
    // The case this exists for: nothing in the path preserves key order — not HTTP,
    // not a client rebuilding its retry body from an object, not MySQL's JSON type.
    const a = { memo: 'rent', date: '2026-07-01', lines: [{ side: 'debit', amount: 100n }] };
    const b = { lines: [{ amount: 100n, side: 'debit' }], date: '2026-07-01', memo: 'rent' };

    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('treats an explicitly undefined property as an absent one', () => {
    // `exactOptionalPropertyTypes` makes these different TypeScript types and JSON
    // makes them the same document. The wire is the arbiter, so they must agree.
    expect(canonicalize({ memo: 'rent', reference: undefined })).toBe(
      canonicalize({ memo: 'rent' }),
    );
  });

  it('is stable across calls and produces a CHAR(64)-shaped digest', () => {
    const digest = fingerprintOf({ lines: [1n, 2n], nested: { deep: [true, null] } });

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf({ lines: [1n, 2n], nested: { deep: [true, null] } })).toBe(digest);
  });
});

describe('different requests never share a fingerprint', () => {
  it('distinguishes a string, a number, and a bigint holding the same digits', () => {
    // `JSON.stringify` collapses the number and the bigint would throw. An amount
    // arriving as 100 instead of 100n is a different request.
    const encodings = new Set([
      canonicalize({ amount: '100' }),
      canonicalize({ amount: 100 }),
      canonicalize({ amount: 100n }),
    ]);

    expect(encodings.size).toBe(3);
  });

  it('distinguishes true from the string "true", and null from "null"', () => {
    expect(canonicalize({ posted: true })).not.toBe(canonicalize({ posted: 'true' }));
    expect(canonicalize({ closedAt: null })).not.toBe(canonicalize({ closedAt: 'null' }));
  });

  it('cannot be confused by a key or value containing the encoding delimiters', () => {
    // The reason every string carries its length. Concatenating keys and values
    // without one makes these two objects encode identically.
    expect(canonicalize({ 'a:b': 1n })).not.toBe(canonicalize({ a: ':b:1' }));
    expect(canonicalize({ a: 's1:b' })).not.toBe(canonicalize({ a: 'b' }));
  });

  it('cannot be confused by a nested object whose encoding resembles a sibling', () => {
    expect(canonicalize({ a: { b: 1n } })).not.toBe(canonicalize({ a: 'o1:s1:bi1' }));
  });

  it('preserves array order, because line order is semantic', () => {
    // Debit-then-credit and credit-then-debit produce different journals.
    expect(canonicalize([1n, 2n])).not.toBe(canonicalize([2n, 1n]));
  });

  it('distinguishes an absent array element from a null one', () => {
    expect(canonicalize([undefined])).not.toBe(canonicalize([null]));
  });

  it('distinguishes a Date from its own ISO string', () => {
    const instant = new Date('2026-07-01T12:00:00.000Z');

    expect(canonicalize({ at: instant })).not.toBe(canonicalize({ at: instant.toISOString() }));
  });

  it('separates the same body sent to two different endpoints', () => {
    // Same key, same body, different route is a reused key, not a retry. The
    // endpoint is in the hashed input so one CHAR(64) comparison catches it.
    const request = { id: 'a3f1' };

    expect(fingerprintOf(request, 'journals.post')).not.toBe(
      fingerprintOf(request, 'journals.reverse'),
    );
  });
});

describe('unfingerprintable values are a fault, not a guess', () => {
  // Every one of these would otherwise be silently dropped or coerced by
  // `JSON.stringify`, and a dropped field means two different requests colliding.
  it.each([
    ['a function', { handler: () => undefined }],
    ['a symbol', { tag: Symbol('x') }],
    ['a Map', { lines: new Map([['a', 1]]) }],
    ['a Set', { tags: new Set(['a']) }],
    ['a Buffer', { id: Buffer.from('00', 'hex') }],
    ['NaN', { amount: Number.NaN }],
    ['Infinity', { amount: Number.POSITIVE_INFINITY }],
    ['an invalid Date', { at: new Date('not a date') }],
  ])('rejects %s', (_label, request) => {
    expect(() => canonicalize(request)).toThrow(/fingerprint/i);
  });

  it('rejects a class instance rather than walking it as a plain object', () => {
    class Payload {
      constructor(readonly amount: bigint) {}
    }

    expect(() => canonicalize(new Payload(1n))).toThrow(/Payload/);
  });

  it('rejects a cycle instead of recursing forever', () => {
    const request: Record<string, unknown> = { memo: 'rent' };
    request['self'] = request;

    expect(() => canonicalize(request)).toThrow(/circular/i);
  });

  it('accepts a value referenced twice, which is not a cycle', () => {
    const shared = { amount: 100n };

    expect(() => canonicalize({ first: shared, second: shared })).not.toThrow();
  });
});
