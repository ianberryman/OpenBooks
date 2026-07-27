import {
  MoneyParseError,
  fromMinorString,
  isPositive,
  toMinorUnits,
} from '@openbooks/shared-types/money';

import type { RequestContext } from '../../context';
import { tryUuidToBuffer } from '../../db';
import { ValidationError } from '../../errors';

/**
 * The two conversions every write in this module makes, in one place (OB-064).
 *
 * Both were copied out of `drafts.service.ts`, which is the register this module
 * follows: a wire amount goes through the money module rather than through
 * `BigInt(value)`, and a row with a `NOT NULL` author refuses a context that has
 * no user rather than inventing one.
 */

/**
 * A cents-only wire string as minor units.
 *
 * Through `fromMinorString` rather than `BigInt(value)` because that function is
 * the authority on the format (D-13) and applies the storable-`BIGINT` bound, so
 * an over-large amount is a validation failure at the edge rather than a driver
 * error surfacing as an opaque 500.
 */
export function minorUnits(value: string): bigint {
  return toMinorUnits(fromMinorString(value));
}

const NOT_POSITIVE =
  'This amount must be a positive number of minor units. A payment in the other direction is ' +
  'how money going the other way is recorded, and removing an allocation is its own operation ' +
  '— neither is a negative amount.';

/**
 * Why an amount is unusable, or `undefined` when it is fine.
 *
 * A returned message rather than a throw, so a caller validating several amounts
 * reports all of them in one pass — the habit `toPostJournalInput` follows, and it
 * matters most on a batch of allocations, where fixing one line per attempt is the
 * difference between a usable API and a guessing game.
 *
 * Two things are checked and they come from different places. The *format* is
 * `fromMinorString`'s, which is the authority on D-13's cents-only string and also
 * applies the storable-`BIGINT` bound, so an over-large amount is refused here
 * rather than reaching the driver as an opaque 500. The *sign* is the schema's
 * gap: `minorUnitsSchema` accepts `"0"` and `"-150000"` because it describes a
 * format and not a business rule, while `chk_payments_amount` and
 * `chk_ar_allocations_amount` both require a positive amount — so without this the
 * refusal would arrive as a CHECK violation naming nothing a client can act on.
 */
export function amountProblem(value: string): string | undefined {
  try {
    return isPositive(fromMinorString(value)) ? undefined : NOT_POSITIVE;
  } catch (error) {
    return error instanceof MoneyParseError
      ? error.message
      : 'Expected a canonical integer string of minor units.';
  }
}

/** The same check, for a lone field, thrown against the path that carries it. */
export function positiveMinorUnits(value: string, path: string): bigint {
  const problem = amountProblem(value);
  if (problem !== undefined) {
    throw new ValidationError('Amount must be positive.', [{ path, message: problem }]);
  }
  return minorUnits(value);
}

/**
 * The user a payment or an allocation is recorded by.
 *
 * `payments.created_by_user_id` and `ar_allocations.created_by_user_id` are both
 * `NOT NULL` and reference `users`, so a context with no user identity — an
 * automation or an agent acting outside a member session — has nothing to record
 * one as. `requireAuthor` in `drafts.service.ts` refuses the same way for the same
 * column, and this follows it rather than inventing a second convention.
 */
export function requireRecordingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A payment is recorded by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot record a payment or an allocation. ' +
          'Both are attributed to the person who made them.',
      },
    ]);
  }
  return userId;
}
