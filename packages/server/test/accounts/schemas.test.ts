import {
  ACCOUNT_CODE_MAX_LENGTH,
  ACCOUNT_TYPES,
  accountPageSchema,
  accountSchema,
  createAccountRequestSchema,
  listAccountsQuerySchema,
  NORMAL_BALANCES,
  updateAccountRequestSchema,
} from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseInput, ValidationError } from '../../src/errors';

/**
 * The wire contract, asserted without a database.
 *
 * These are statements about what the API accepts, which is a decision rather than
 * a consequence — most of all the absence of `code` from the update body (D-27).
 * Nothing here needs MySQL, but it lives in the server suite because `parseInput`
 * (the Zod → error-model conversion) is server-side and asserting the schemas
 * without it would leave the conversion untested.
 */
describe('account schemas', () => {
  const valid = {
    code: '1000',
    name: 'Operating bank account',
    type: 'asset',
    normalBalance: 'debit',
  };

  it('matches the account type and normal-balance enums to migration 0002_ledger', () => {
    expect([...ACCOUNT_TYPES]).toEqual(['asset', 'liability', 'equity', 'revenue', 'expense']);
    expect([...NORMAL_BALANCES]).toEqual(['debit', 'credit']);
  });

  /**
   * D-27, pinned where the decision is enforced.
   *
   * The refusal has to be *loud*. A permissive parser would drop the key and return
   * a 200, leaving the client believing it had renumbered an account when the code
   * every journal and export cites is unchanged. `strictObject` makes it a
   * `validation_failed` and `parseInput` puts the field name in `issues[].path`.
   *
   * The snake_case spelling is checked too, because a client that guessed the wrong
   * casing would otherwise get a different error and conclude the field exists.
   *
   * If a future ticket makes codes editable, this is the test that fails, which is
   * the intent: it should be a decision recorded here rather than a schema edit
   * nobody noticed.
   */
  it('rejects code on update, naming the field', () => {
    for (const field of ['code', 'account_code']) {
      const error = (() => {
        try {
          parseInput(updateAccountRequestSchema, { name: 'Renamed', [field]: '1100' });
          return undefined;
        } catch (caught: unknown) {
          return caught;
        }
      })();

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({ issues: [{ path: field }] });
    }
  });

  it('still requires code on create — it is fixed at creation, not absent', () => {
    const { code: _omitted, ...withoutCode } = valid;

    expect(() => parseInput(createAccountRequestSchema, withoutCode)).toThrow(ValidationError);
    expect(parseInput(createAccountRequestSchema, valid).code).toBe('1000');
  });

  /**
   * The inverse of what M1 asserted. `parentAccountId` was refused then because
   * hierarchy was a set of rules that did not exist; OB-035 wrote them, so the shape
   * is accepted here and every rule about it lives in the service — the schema
   * cannot know whether a parent exists, shares a type, or would close a cycle.
   */
  it('accepts parentAccountId as a uuid or null, on create and on update', () => {
    const parent = '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607';

    expect(
      parseInput(createAccountRequestSchema, { ...valid, parentAccountId: parent }),
    ).toMatchObject({ parentAccountId: parent });
    expect(
      parseInput(createAccountRequestSchema, { ...valid, parentAccountId: null }),
    ).toMatchObject({ parentAccountId: null });
    expect(parseInput(updateAccountRequestSchema, { parentAccountId: null })).toMatchObject({
      parentAccountId: null,
    });

    // Still a uuid, so an account code or a slug is a validation failure rather
    // than a lookup that misses.
    expect(() => parseInput(updateAccountRequestSchema, { parentAccountId: '1000' })).toThrow(
      ValidationError,
    );
  });

  it('rejects isActive on update — deactivation is its own operation', () => {
    expect(() => parseInput(updateAccountRequestSchema, { isActive: false })).toThrow(
      ValidationError,
    );
  });

  it('requires normalBalance rather than defaulting it from type', () => {
    const { normalBalance: _omitted, ...withoutNormalBalance } = valid;

    expect(() => parseInput(createAccountRequestSchema, withoutNormalBalance)).toThrow(
      ValidationError,
    );
  });

  it('trims and length-bounds the code', () => {
    expect(parseInput(createAccountRequestSchema, { ...valid, code: ' 1000 ' }).code).toBe('1000');
    expect(() => parseInput(createAccountRequestSchema, { ...valid, code: '   ' })).toThrow(
      ValidationError,
    );
    expect(() =>
      parseInput(createAccountRequestSchema, {
        ...valid,
        code: 'x'.repeat(ACCOUNT_CODE_MAX_LENGTH + 1),
      }),
    ).toThrow(ValidationError);
  });

  it('reports a nested path dotted, as ValidationIssue documents', () => {
    const schema = z.strictObject({ lines: z.array(z.strictObject({ amount: z.string() })) });

    try {
      parseInput(schema, { lines: [{ amount: 1 }] });
      expect.unreachable('should have thrown');
    } catch (error: unknown) {
      expect((error as ValidationError).details).toMatchObject({
        issues: [{ path: 'lines.0.amount' }],
      });
    }
  });

  it('requires at least one field on an update', () => {
    expect(() => parseInput(updateAccountRequestSchema, {})).toThrow(ValidationError);
    expect(() => parseInput(updateAccountRequestSchema, { description: undefined })).toThrow(
      ValidationError,
    );
    expect(parseInput(updateAccountRequestSchema, { description: null }).description).toBeNull();
  });

  /**
   * Component ids, and the rule they follow.
   *
   * `jsonSchemaTransformObject` copies the *whole* zod registry into
   * `components.schemas`, and this module is evaluated in the API process, so an `id`
   * here lands in `openapi.json` whether or not a route references it — and A10 turns
   * any drift in that file into a build failure. OB-018 therefore asserted the ids were
   * *absent*; OB-023 added them in the same diff as the routes that reference them, and
   * this is that assertion inverted.
   *
   * The half that still needs guarding is the other one: `listAccountsQuerySchema`
   * describes a querystring, which is emitted as individual `parameters` rather than as
   * a schema reference, so an id on it would be a component nothing points at.
   */
  it('names the schemas the account routes reference, and only those', () => {
    for (const [schema, id] of [
      [accountSchema, 'Account'],
      [createAccountRequestSchema, 'CreateAccountRequest'],
      [updateAccountRequestSchema, 'UpdateAccountRequest'],
      [accountPageSchema, 'AccountPage'],
    ] as const) {
      expect(z.globalRegistry.get(schema)?.id).toBe(id);
    }

    expect(z.globalRegistry.get(listAccountsQuerySchema)?.id).toBeUndefined();
  });
});
