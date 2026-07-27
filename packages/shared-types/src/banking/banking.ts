import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema, pageCursorSchema } from '../wire';

/**
 * The vocabulary M4's banking contracts share (OB-075; ROADMAP D-41 through D-47).
 *
 * Eight resources arrive across six waves — a bank account, an import, a mapping, a
 * statement line, a rule, a match proposal, a clearing, a reconciliation session —
 * and three of the waves fan out into parallel tickets. This file holds what more
 * than one of them needs, for `subledger/documents.ts`'s reason: a direction, a date
 * window and a page envelope that meant subtly different things per resource would
 * give the generated client several unrelated types for one idea, and give a screen
 * several ways to be wrong.
 *
 * ## Nothing in this module carries `.meta({ id })` yet
 *
 * The transform lifts every schema carrying an `id` out of zod's global registry
 * into `components.schemas` whether or not a route references it, so an `id` added
 * before OB-084's routes publishes a component nothing can reach and A10 fails the
 * build in a ticket that touched no routes. OB-061 held the same line for all of M3
 * and OB-067 added the ids in the same diff as the routes; `contracts.test.ts`
 * asserts the empty set until then.
 *
 * ## The two absences that shape all of M4
 *
 * **No balance on a bank account** (D-46). The balance is the ledger account's, and
 * the statement's closing figure is a *claim from outside* that reconciliation
 * exists to test against it — so it lives on the import that carried it and on the
 * session that asserts it, never on the account.
 *
 * **No write anywhere on the matching path** (D-43, E3). There is no auto-post
 * shape in this module: a proposal is ranked and explained, and accepting it — a
 * separate request, carrying the actor provenance every posting carries — is the
 * only thing that reaches the ledger. Confidence lives in the ordering, not in a
 * decision to write.
 */

/**
 * Which way the money went on a statement line.
 *
 * A statement line carries a **signed** amount and no direction field of its own
 * (`bankStatementLineSchema`); this enum exists for the places that *select* on the
 * sign — a rule's condition (D-44 matches on "description, amount and direction")
 * and a line-list filter. Storing the direction beside the sign would be two
 * encodings of one fact, and the first thing to disagree with a signed amount is
 * the label printed next to it.
 *
 * `inbound` is `amount > 0`, `outbound` is `amount < 0`, strictly. A zero-amount
 * line — some banks emit them for a reversal pair — is in neither, and a direction
 * filter therefore excludes it rather than guessing.
 */
export const BANK_LINE_DIRECTIONS = ['inbound', 'outbound'] as const;

export type BankLineDirection = (typeof BANK_LINE_DIRECTIONS)[number];

export const bankLineDirectionSchema = z.enum(BANK_LINE_DIRECTIONS).meta({
  description:
    'Which way the money went. `inbound` selects lines with a positive amount, `outbound` a ' +
    'negative one — strictly, so a zero-amount line matches neither. Not a field on a line: a ' +
    'line carries a signed amount, and a label beside it would be a second encoding of the sign.',
});

/**
 * A statement line's amount, **signed**, in minor units (D-13).
 *
 * Signed rather than a positive amount plus a direction, and this is the one place
 * the choice is load-bearing rather than stylistic: E4 requires that a cleared line
 * and the entry it clears agree *exactly*, which is an equation over amounts. An
 * equation whose terms each need a sign looked up from a neighbouring enum is an
 * equation with a conditional in it, and the conditional is where the sign error
 * goes. `clearedAmount + differenceAmount === amount` has no conditional.
 *
 * A cents-only string and never a JSON number, for D-13's reason: `"1500.00"` is
 * refused, `150000` is refused, and the authority is `fromMinorString` rather than
 * a pattern that agrees with it today.
 */
export const bankLineAmountSchema = minorUnitsSchema.meta({
  description:
    'What the bank moved, in minor units, signed — positive into the account, negative out of ' +
    'it. Signed rather than magnitude-plus-direction because E4 is an equation over amounts, and ' +
    'a term whose sign must be looked up is where a sign error goes.',
});

/**
 * The date window every banking list filters on, inclusive at both ends.
 *
 * Restated rather than shared with `documentDateRangeShape`, for the reason that
 * one was restated from `reportRangeShape`: this bounds a *statement* date, and two
 * shapes that happen to be identical today diverge the moment either grows a field.
 */
export const bankDateRangeShape = {
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
};

/**
 * A page envelope with no `id`, which is the only reason it is not `pageSchema`.
 *
 * `pageSchema` requires an `id` deliberately, and M4 has no routes until OB-084, so
 * every page here would publish a component nothing could reach (A10). The keys are
 * the shared envelope's (D-21), so OB-084 replaces these calls with `pageSchema`
 * calls and nothing downstream moves — which is exactly what OB-067 did to M3's
 * copy of this helper, and OB-045 to M2's.
 */
export function unpublishedPageSchema<Item extends z.ZodType>(item: Item) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: pageCursorSchema.nullable(),
  });
}
