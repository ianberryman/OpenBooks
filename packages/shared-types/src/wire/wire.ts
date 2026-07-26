import { z } from 'zod';

import { fromMinorString, MoneyParseError } from '../money';

/**
 * The scalar wire formats every module's request and response schemas are built
 * from (spec §3).
 *
 * Both schemas here carry an `id`, so each becomes one named `components.schemas`
 * entry that every route `$ref`s. That is worth the two entries per id
 * (`fastify-type-provider-zod` emits one per io direction) for a different reason
 * than `ErrorResponse`: these are the two formats an integrator is most likely to
 * get wrong, and a named type in the generated client (OB-024) is where they will
 * read the rule.
 */

/**
 * D-13's format as a JSON Schema `pattern`, so the published artifact states the
 * rule machine-readably and a generated client can enforce it before a request is
 * sent.
 *
 * It is a *restatement* of `MINOR_UNITS_PATTERN` in `../money/money.ts`, which is
 * module-private there, and it is deliberately not what enforces anything: the
 * refinement below calls `fromMinorString`, which is the authority. So if the two
 * ever disagree the artifact is merely imprecise rather than wrong — the value a
 * request may carry is decided by one function, in one place, for every caller.
 */
export const MINOR_UNITS_WIRE_PATTERN = '^-?(?:0|[1-9][0-9]*)$';

/**
 * Money on the wire: a string containing nothing but an integer count of minor
 * units (D-13). `"150000"` is 1,500.00 in a two-decimal currency.
 *
 * A string and never a JSON number, because a JSON number is an IEEE-754 double in
 * every mainstream parser — the ceiling at 2^53 is invisible and the layer that
 * silently rounds is the one we do not control. And *cents* and never an amount,
 * because a decimal form would require every reader to know the currency exponent,
 * which is the coupling to avoid before multi-currency arrives (spec §13).
 *
 * Validated by handing the value to `fromMinorString` rather than by re-deriving
 * its rules. That buys three things at once: `"1500.00"`, `"1.5"`, `"1e5"`,
 * `"+150000"` and `"01500"` are refused exactly as the money module refuses them;
 * the storable-`BIGINT` bound is applied at the edge, so `"99999999999999999999"`
 * is a `validation_failed` naming the field rather than a driver error surfacing as
 * a 500; and the message a client sees is the money module's own, which names which
 * of those it hit.
 *
 * No transform to `Money`. The parsed value stays the string it was on the wire,
 * so the schema means the same thing in both io directions and the conversion is a
 * visible step in the route's argument mapping.
 */
export const minorUnitsSchema = z
  .string()
  .superRefine((value, ctx) => {
    try {
      fromMinorString(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message:
          error instanceof MoneyParseError
            ? error.message
            : 'Expected a canonical integer string of minor units.',
      });
    }
  })
  .meta({
    id: 'MinorUnits',
    description:
      'An exact monetary amount as a string of minor units — an integer count of cents with ' +
      'no decimal point, no separators, and no leading zeros. `"150000"` is 1,500.00 in a ' +
      'two-decimal currency. Never a JSON number, and never a decimal amount: `"1500.00"` is ' +
      'refused.',
    pattern: MINOR_UNITS_WIRE_PATTERN,
    examples: ['150000', '-150000', '0'],
  });

/**
 * An accounting date, `YYYY-MM-DD`.
 *
 * `z.iso.date()` rather than a regular expression, for the reason the periods
 * module gives at its own copy: it rejects impossible dates and not merely
 * malformed ones, so `2026-02-30` is answered here instead of reaching MySQL to be
 * coerced or refused by the driver.
 *
 * A calendar date and never an instant. Which fiscal period a journal lands in must
 * not depend on the reader's timezone (plugin-api `primitives.ts`).
 */
export const calendarDateSchema = z.iso.date().meta({
  id: 'CalendarDate',
  description:
    'A calendar date, `YYYY-MM-DD`. Not an instant: an accounting date carries no time and no ' +
    'timezone, because which fiscal period an entry lands in must not depend on the reader’s.',
  examples: ['2026-03-31'],
});
