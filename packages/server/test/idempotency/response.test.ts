import { fromMinorUnits } from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';

import {
  normalizeResponseBody,
  serializeResponseBody,
} from '../../src/modules/idempotency/response';

/**
 * How a response becomes a `response_body` JSON column value (OB-017, spec §12).
 *
 * The round trip through real MySQL is in `service.test.ts`; this covers the
 * conversion itself, where the money decision lives. `JSON.stringify` throws on
 * `bigint` and this normalization runs *inside the guarded transaction*, so an
 * unconverted amount would roll back a write that had already succeeded — which
 * makes "does a money-bearing response serialize" a correctness question, not a
 * formatting one.
 */

describe('money crosses the JSON column as a decimal string of minor units', () => {
  it('renders a Money value as its minor units', () => {
    expect(normalizeResponseBody({ total: fromMinorUnits(123456n) })).toEqual({
      total: '123456',
    });
  });

  it('keeps full precision above 2^53, where a JSON number would not', () => {
    const beyondDouble = 9007199254740993n;

    const body = normalizeResponseBody({ total: fromMinorUnits(beyondDouble) });

    expect(body).toEqual({ total: '9007199254740993' });
    // The point of the string, stated as an assertion: the same value routed
    // through a JSON number comes back one minor unit light.
    expect(Number('9007199254740993')).toBe(9007199254740992);
    expect(BigInt('9007199254740993')).toBe(beyondDouble);
  });

  it('renders negative and zero amounts without a sign surprise', () => {
    expect(
      normalizeResponseBody([fromMinorUnits(-1n), fromMinorUnits(0n), fromMinorUnits(-250n)]),
    ).toEqual(['-1', '0', '-250']);
  });

  it('converts amounts at any depth, since a DTO nests them', () => {
    const body = normalizeResponseBody({
      journalId: 'a3f1',
      lines: [{ amount: fromMinorUnits(100n) }, { amount: fromMinorUnits(-100n) }],
      totals: { debit: fromMinorUnits(100n), credit: fromMinorUnits(100n) },
    });

    expect(body).toEqual({
      journalId: 'a3f1',
      lines: [{ amount: '100' }, { amount: '-100' }],
      totals: { debit: '100', credit: '100' },
    });
  });

  it('produces text JSON.stringify can no longer choke on', () => {
    const body = normalizeResponseBody({ total: fromMinorUnits(100n) });

    expect(serializeResponseBody(body)).toBe('{"total":"100"}');
    // The failure this replaces: the same object before normalization.
    expect(() => JSON.stringify({ total: fromMinorUnits(100n) })).toThrow(TypeError);
  });
});

describe('JSON.stringify semantics, with the silent cases made loud', () => {
  it('stores a body-less response as null', () => {
    // A 204 and a null body are the same stored state; mysql2 cannot tell SQL NULL
    // from JSON null on the way back, so the status carries the distinction.
    expect(normalizeResponseBody(undefined)).toBeNull();
    expect(normalizeResponseBody(null)).toBeNull();
  });

  it('omits undefined properties and keeps null ones', () => {
    expect(normalizeResponseBody({ memo: null, reference: undefined })).toEqual({ memo: null });
  });

  it('renders a Date as an ISO instant', () => {
    expect(normalizeResponseBody({ postedAt: new Date('2026-07-01T12:00:00.000Z') })).toEqual({
      postedAt: '2026-07-01T12:00:00.000Z',
    });
  });

  it('rejects a non-finite number rather than storing JSON null for it', () => {
    expect(() => normalizeResponseBody({ rate: Number.NaN })).toThrow(/non-finite/);
    expect(() => normalizeResponseBody({ rate: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('rejects binary data, which means a BINARY(16) id escaped into a response', () => {
    // `Buffer.toJSON()` would happily store `{ type: 'Buffer', data: [...] }` and
    // the replay would keep serving it for the whole retention window.
    expect(() => normalizeResponseBody({ id: Buffer.alloc(16) })).toThrow(/binary/i);
  });

  it('rejects a function or a symbol instead of dropping it', () => {
    expect(() => normalizeResponseBody({ render: () => undefined })).toThrow(/function/);
    expect(() => normalizeResponseBody({ tag: Symbol('x') })).toThrow(/symbol/);
  });

  it('rejects a cycle', () => {
    const body: Record<string, unknown> = { journalId: 'a3f1' };
    body['self'] = body;

    expect(() => normalizeResponseBody(body)).toThrow(/circular/i);
  });

  it('allows a value referenced twice', () => {
    const shared = { amount: fromMinorUnits(100n) };

    expect(normalizeResponseBody({ debit: shared, credit: shared })).toEqual({
      debit: { amount: '100' },
      credit: { amount: '100' },
    });
  });
});
