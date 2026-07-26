import {
  ACCOUNT_CODE_MAX_LENGTH,
  ACCOUNT_TYPES,
  accountListSchema,
  accountSchema,
  createAccountRequestSchema,
  listAccountsQuerySchema,
  NORMAL_BALANCES,
  updateAccountRequestSchema,
} from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ValidationError } from '../../src/errors';
import { parseInput } from '../../src/modules/accounts/input';

/**
 * The wire contract, asserted without a database.
 *
 * These are statements about what the API accepts, which is a decision rather than
 * a consequence — most of all the absence of `parentAccountId`. Nothing here needs
 * MySQL, but it lives in the server suite because `parseInput` (the Zod → error-model
 * conversion) is server-side and asserting the schemas without it would leave the
 * conversion untested.
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
   * The `parent_account_id` decision, pinned.
   *
   * The column exists from M1 and hierarchy is M2, so the API must not accept the
   * field — and, more particularly, must not accept it *silently*. A permissive
   * parser would drop the key and return a 201, leaving the client believing it had
   * built a tree. `strictObject` makes it a `validation_failed` naming the field,
   * and `parseInput` puts the field name in `issues[].path`.
   *
   * If a future ticket adds hierarchy, this test is the one that fails, which is the
   * intent: the change should be a decision recorded here rather than a schema edit
   * nobody noticed.
   */
  it('rejects parentAccountId on create, naming the field', () => {
    for (const field of ['parentAccountId', 'parent_account_id']) {
      const error = (() => {
        try {
          parseInput(createAccountRequestSchema, {
            ...valid,
            [field]: '2f1b2b3c-4d5e-4f60-8a71-b2c3d4e5f607',
          });
          return undefined;
        } catch (caught: unknown) {
          return caught;
        }
      })();

      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details).toMatchObject({
        issues: [{ path: field }],
      });
    }
  });

  it('rejects parentAccountId on update too', () => {
    expect(() =>
      parseInput(updateAccountRequestSchema, { name: 'Renamed', parentAccountId: null }),
    ).toThrow(ValidationError);
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
      [accountListSchema, 'AccountList'],
    ] as const) {
      expect(z.globalRegistry.get(schema)?.id).toBe(id);
    }

    expect(z.globalRegistry.get(listAccountsQuerySchema)?.id).toBeUndefined();
  });
});
