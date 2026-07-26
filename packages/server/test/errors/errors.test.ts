import { describe, expect, it } from 'vitest';
import {
  assertFound,
  assertOrgMatch,
  ConflictError,
  ERROR_CODE_STATUS,
  ERROR_CODES,
  IdempotencyKeyConflictError,
  InternalError,
  isOpenBooksError,
  NotFoundError,
  PermissionDeniedError,
  PreconditionFailedError,
  toWireError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/errors/index';
import type { ErrorCode, HttpErrorStatus, OpenBooksError } from '../../src/errors/index';

describe('the code registry', () => {
  it('gives every code exactly one status', () => {
    const codes = Object.values(ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(ERROR_CODE_STATUS[code]).toBeTypeOf('number');
    }
    expect(Object.keys(ERROR_CODE_STATUS).sort()).toEqual([...codes].sort());
  });
});

describe('error → status and code', () => {
  const cases: readonly {
    readonly name: string;
    readonly error: OpenBooksError;
    readonly code: ErrorCode;
    readonly status: HttpErrorStatus;
  }[] = [
    {
      name: 'validation failure',
      error: new ValidationError('Journal does not balance.'),
      code: 'validation_failed',
      status: 400,
    },
    {
      name: 'unauthenticated',
      error: new UnauthenticatedError(),
      code: 'unauthenticated',
      status: 401,
    },
    {
      name: 'permission denied',
      error: new PermissionDeniedError('journals.post'),
      code: 'permission_denied',
      status: 403,
    },
    {
      name: 'not found',
      error: new NotFoundError('journal'),
      code: 'not_found',
      status: 404,
    },
    {
      name: 'conflict',
      error: new ConflictError('Account code 4000 already exists.'),
      code: 'conflict',
      status: 409,
    },
    {
      name: 'idempotency key conflict',
      error: new IdempotencyKeyConflictError(),
      code: 'idempotency_key_conflict',
      status: 409,
    },
    {
      name: 'precondition failed',
      error: new PreconditionFailedError('period_open', 'The period 2026-06 is closed.'),
      code: 'precondition_failed',
      status: 412,
    },
    {
      name: 'internal error',
      error: new InternalError('connect ECONNREFUSED 10.0.1.4:3306'),
      code: 'internal_error',
      status: 500,
    },
  ];

  for (const { name, error, code, status } of cases) {
    it(`maps ${name} to ${String(status)} / ${code}`, () => {
      expect(error).toBeInstanceOf(Error);
      expect(isOpenBooksError(error)).toBe(true);
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);

      const wire = toWireError(error);
      expect(wire.code).toBe(code);
      expect(wire.status).toBe(status);
    });
  }

  it('names each class, so log lines identify the failure', () => {
    expect(new NotFoundError('journal').name).toBe('NotFoundError');
    expect(new IdempotencyKeyConflictError().name).toBe('IdempotencyKeyConflictError');
  });
});

describe('serialization for the HTTP layer', () => {
  it('carries validation issues as structure, not prose', () => {
    const error = new ValidationError('Request is invalid.', [
      { path: 'lines.0.amount', message: 'must not be zero' },
    ]);

    expect(toWireError(error)).toEqual({
      code: 'validation_failed',
      status: 400,
      message: 'Request is invalid.',
      details: { issues: [{ path: 'lines.0.amount', message: 'must not be zero' }] },
    });
  });

  it('omits details entirely when there are none', () => {
    expect('details' in toWireError(new UnauthenticatedError())).toBe(false);
  });

  it('keeps an internal error’s operator message out of the response', () => {
    const error = new InternalError('mysql://app:hunter2@10.0.1.4/openbooks unreachable');

    expect(error.message).toContain('hunter2');
    expect(toWireError(error).message).toBe('An internal error occurred.');
  });

  it('treats anything it does not recognise as an opaque internal error', () => {
    for (const thrown of [new TypeError('cannot read x of undefined'), 'boom', undefined, 42]) {
      expect(toWireError(thrown)).toEqual({
        code: 'internal_error',
        status: 500,
        message: 'An internal error occurred.',
      });
    }
  });
});

describe('A7 — a cross-org read is indistinguishable from a genuine miss', () => {
  /**
   * Stands in for `tenantDb(ctx)` (OB-013): the org predicate is part of the
   * query, so a row belonging to another org is simply not returned. Both callers
   * below therefore reach the same zero-row path.
   */
  const findJournal = (orgId: string, id: string): { readonly id: string } | undefined => {
    const table = [{ orgId: 'org-b', id: 'journal-owned-by-b' }];
    const row = table.find((candidate) => candidate.orgId === orgId && candidate.id === id);
    return row === undefined ? undefined : { id: row.id };
  };

  const load = (orgId: string, id: string): { readonly id: string } =>
    assertFound(findJournal(orgId, id), 'journal');

  it('produces byte-identical responses for a cross-org id and an unknown id', () => {
    let crossOrg: unknown;
    let unknown: unknown;

    // org-a asking for a journal that exists — in org-b.
    try {
      load('org-a', 'journal-owned-by-b');
    } catch (error: unknown) {
      crossOrg = error;
    }

    // org-a asking for a journal that has never existed anywhere.
    try {
      load('org-a', 'journal-never-created');
    } catch (error: unknown) {
      unknown = error;
    }

    expect(crossOrg).toBeInstanceOf(NotFoundError);
    expect(unknown).toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(toWireError(crossOrg))).toBe(JSON.stringify(toWireError(unknown)));
    expect(toWireError(crossOrg)).toEqual({
      code: 'not_found',
      status: 404,
      message: 'No such journal.',
      details: { resource: 'journal' },
    });
  });

  it('sanity check: the row is genuinely there for its own org', () => {
    expect(load('org-b', 'journal-owned-by-b')).toEqual({ id: 'journal-owned-by-b' });
  });

  it('answers an ownership mismatch with 404, never 403', () => {
    let thrown: unknown;
    try {
      assertOrgMatch('org-a', 'org-b', 'journal');
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NotFoundError);
    expect(JSON.stringify(toWireError(thrown))).toBe(
      JSON.stringify(toWireError(new NotFoundError('journal'))),
    );
  });

  it('offers no channel for a distinguishing detail', () => {
    // Free text is how a 404 stops being uniform. The constructor rejects it, so
    // "invoice 42, owned by another org" is not an expressible not-found.
    expect(() => new NotFoundError('journal 42 belongs to org-b')).toThrow(
      /stable identifier token/u,
    );
    expect(() => new PermissionDeniedError('you may not read org-b’s journals')).toThrow(
      /stable identifier token/u,
    );
  });

  it('accepts the identifier shapes real resources and permissions use', () => {
    expect(new NotFoundError('fiscal_period').code).toBe('not_found');
    expect(new NotFoundError('trial-balance').code).toBe('not_found');
    expect(new PermissionDeniedError('journals.post').details).toEqual({
      permission: 'journals.post',
    });
  });
});

describe('assertFound', () => {
  it('passes a present value through and narrows it', () => {
    expect(assertFound<string | null>('value', 'journal')).toBe('value');
  });

  it('throws for null and for undefined alike', () => {
    expect(() => assertFound(null, 'journal')).toThrow(NotFoundError);
    expect(() => assertFound(undefined, 'journal')).toThrow(NotFoundError);
  });
});
