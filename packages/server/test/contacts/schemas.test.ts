import {
  CONTACT_CODE_MAX_LENGTH,
  CONTACT_NOTES_MAX_LENGTH,
  contactPageSchema,
  contactSchema,
  createContactRequestSchema,
  listContactsQuerySchema,
  updateContactRequestSchema,
} from '@openbooks/shared-types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseInput, ValidationError } from '../../src/errors';

/**
 * The wire contract, asserted without a database.
 *
 * These are statements about what the API accepts, which is a decision rather than
 * a consequence — most of all the *presence* of `code` in the update body, which
 * is where this contract deliberately parts company with D-27. Nothing here needs
 * MySQL, but it lives in the server suite because `parseInput` (the Zod → error
 * model conversion) is server-side and asserting the schemas without it would
 * leave the conversion untested.
 */
describe('contact schemas', () => {
  /**
   * D-27's precedent, deliberately not followed, pinned where the divergence is
   * expressed.
   *
   * `updateAccountRequestSchema` omits `code` so that sending one is a
   * `validation_failed`; this schema accepts it. If a future ticket makes contact
   * codes immutable, this is the test that fails — which is the intent: it should
   * be a decision recorded against the argument in `contacts.ts`, not a schema edit
   * nobody noticed.
   */
  it('accepts a code on update, and accepts null to give one up', () => {
    expect(parseInput(updateContactRequestSchema, { code: 'V-200' })).toEqual({ code: 'V-200' });
    expect(parseInput(updateContactRequestSchema, { code: null })).toEqual({ code: null });
  });

  /**
   * `strictObject`, so a field that is not part of the contract is a
   * `validation_failed` naming it rather than a silent drop. `isActive` is the one
   * a client is most likely to try: deactivation is its own operation, and a client
   * that guessed otherwise has to learn it was refused.
   */
  it('rejects isActive on update, naming the field', () => {
    for (const field of ['isActive', 'is_active']) {
      const error = (() => {
        try {
          parseInput(updateContactRequestSchema, { displayName: 'Acme', [field]: false });
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

  it('requires at least one field on update', () => {
    expect(() => parseInput(updateContactRequestSchema, {})).toThrow(ValidationError);
  });

  it('requires a display name on create and defaults nothing else', () => {
    expect(() => parseInput(createContactRequestSchema, {})).toThrow(ValidationError);

    // The two flags are absent from the parsed output rather than defaulted to
    // false, because the service defaults them from the column defaults in
    // `0002_ledger` — a `.default()` here would put them in the request type and
    // oblige every caller to state them.
    expect(parseInput(createContactRequestSchema, { displayName: 'Acme' })).toEqual({
      displayName: 'Acme',
    });
  });

  it('trims before the length checks so the stored value is the checked one', () => {
    const parsed = parseInput(createContactRequestSchema, {
      displayName: '  Acme Supplies  ',
      code: '  V-100  ',
      email: '  ap@acme.test  ',
    });

    expect(parsed).toMatchObject({
      displayName: 'Acme Supplies',
      code: 'V-100',
      email: 'ap@acme.test',
    });
  });

  it('bounds the code and the notes at the column widths', () => {
    expect(() =>
      parseInput(createContactRequestSchema, {
        displayName: 'Acme',
        code: 'x'.repeat(CONTACT_CODE_MAX_LENGTH + 1),
      }),
    ).toThrow(ValidationError);

    expect(() =>
      parseInput(createContactRequestSchema, {
        displayName: 'Acme',
        notes: 'x'.repeat(CONTACT_NOTES_MAX_LENGTH + 1),
      }),
    ).toThrow(ValidationError);
  });

  /**
   * Phone is length-bounded and not format-checked, deliberately. A regex here
   * would refuse real numbers — extensions, the `+44 (0)` form — and catch nothing
   * an accounting system depends on, since nothing computes on the field.
   */
  it('accepts a phone number in whatever form the org keeps it', () => {
    for (const phone of ['+44 (0)20 7946 0000', '555-0100 x220', '0800 GET HELP']) {
      expect(parseInput(createContactRequestSchema, { displayName: 'Acme', phone })).toMatchObject({
        phone,
      });
    }
  });

  /**
   * The filters are real booleans, not query-string flags. A shared schema that
   * accepted `'false'` would accept it from a JSON body too, and `'false'` is
   * truthy in every language an integrator might use — coercing a querystring is
   * the route's job (OB-045).
   */
  it('takes booleans and not strings for the list filters', () => {
    expect(parseInput(listContactsQuerySchema, { isCustomer: true })).toMatchObject({
      isCustomer: true,
    });
    expect(() => parseInput(listContactsQuerySchema, { isCustomer: 'false' })).toThrow(
      ValidationError,
    );
  });

  /**
   * No schema in this module carries a `.meta({ id })`, and it has to stay that
   * way until OB-045 adds the routes: the OpenAPI transform copies the whole zod
   * registry into `components.schemas`, so an `id` here would publish a component
   * no route can reach and A10 makes the resulting drift a build failure.
   */
  it('registers no OpenAPI component, because contacts have no routes yet', () => {
    for (const schema of [
      contactSchema,
      contactPageSchema,
      createContactRequestSchema,
      updateContactRequestSchema,
      listContactsQuerySchema,
    ]) {
      expect(z.globalRegistry.get(schema)?.id).toBeUndefined();
    }
  });
});
