/**
 * The one conversion from a wire amount to a displayable one (ROADMAP D-13).
 *
 * ## What arrives, and what must not happen to it
 *
 * Money crosses this API as a string of **minor units and nothing else** — `"150000"` is
 * 1500.00, `"-5"` is -0.05. The generated types say `string` because that is what it is;
 * they cannot say "cents", so this module is where that meaning is enforced.
 *
 * The conversion is string manipulation. `Number(cents) / 100` produces
 * `1234.5599999999999` for values that have an exact decimal representation, and
 * `Number` itself silently rounds above 2^53 — the ceiling D-13 chose a string to escape.
 * There is no numeric type anywhere in this file: not `number`, and not even `bigint`,
 * which the server-side `toDecimalString` uses for its divmod. Slicing digits cannot lose
 * one.
 *
 * ## Why this is not `@openbooks/shared-types`
 *
 * `packages/shared-types/src/money/` has `toDecimalString`, and duplicating an algorithm
 * is a real cost, so the reasons are specific:
 *
 * 1. `@openbooks/shared-types` is not a dependency of `@openbooks/web`, and this ticket
 *    may not edit any `package.json`. Reaching it anyway — it resolves through the
 *    `paths` in `tsconfig.base.json` — would typecheck and then fail at `vite build`,
 *    which resolves nothing of the sort. The web bundle's resolution story is Vite's,
 *    with no alias; the server's src-consumed-directly story (D-12) is bought with an
 *    esbuild alias that only the server bundle has.
 * 2. The shared API is built on the branded `Money` bigint, so the web package could not
 *    call `toDecimalString(wireAmount)` at all. It would have to `fromMinorString` first
 *    — pulling in the parser, `MoneyParseError`, the range bounds, and `zod` behind
 *    `src/index.ts` — to reach a function whose input and output here are both strings.
 * 3. What must not be duplicated is the *contract*, and it is not: `openapi.json` states
 *    the format, `fromMinorString` is the only thing that admits values into the system,
 *    and this is a projection of a value that has already been validated by the server.
 *
 * The trade is that the exponent is stated twice. That is bounded and it has a named
 * trigger: `MINOR_UNIT_EXPONENT` becomes per-currency when multi-currency arrives (spec
 * §13), and at that point this file must not "also change" — it must be deleted in favour
 * of a shared, zero-dependency money package that both the server and the browser depend
 * on. Nothing about a two-decimal currency should be a private fact of the web bundle for
 * longer than that.
 */

/**
 * Fixed at 2, matching `MINOR_UNIT_EXPONENT` in `packages/shared-types/src/money/`.
 *
 * Not a knob. `formatMinorUnits` slices the last `MINOR_UNIT_EXPONENT` characters, and at
 * 0 that slices nothing — a zero-decimal currency (JPY) needs the shared package
 * described above, not a smaller number here.
 */
export const MINOR_UNIT_EXPONENT = 2;

/**
 * The same pattern `fromMinorString` validates against: canonical base-10 integer, no
 * separators, no leading zeros, no `+`.
 *
 * Checked rather than assumed even though the value comes from our own server. The failure
 * this catches is not a malicious payload, it is a decimal amount reaching this function
 * from the wrong field — which without the check renders as `"1500.0.00"` and looks like a
 * CSS problem.
 */
const MINOR_UNITS_PATTERN = /^-?(?:0|[1-9][0-9]*)$/;

export class MoneyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyFormatError';
  }
}

/**
 * `"150000"` → `"1500.00"`. Always exactly `MINOR_UNIT_EXPONENT` fraction digits, no
 * thousands separators and no currency symbol.
 *
 * Grouping and symbols are a locale decision this milestone has not made, and when it is
 * made it must go through `Intl.NumberFormat`'s **string** overload — `format("1500.00")`
 * — which parses the decimal string exactly. Passing `Number(…)` to it would reintroduce
 * the float this function exists to avoid, at the last possible moment, where it looks
 * like formatting rather than arithmetic.
 */
export function formatMinorUnits(wireAmount: string): string {
  if (!MINOR_UNITS_PATTERN.test(wireAmount)) {
    throw new MoneyFormatError(
      `Expected a canonical integer string of minor units, received ` +
        `${JSON.stringify(wireAmount)}. Amounts on this API are cents and never decimals ` +
        `(ROADMAP D-13).`,
    );
  }

  /**
   * `"-0"` is canonical on the wire — `MINOR_UNITS_PATTERN` admits it and so does
   * `fromMinorString` — but `bigint` has no negative zero, so the server's
   * `toDecimalString` renders that value `"0.00"`. Dropping the sign here is what keeps
   * the two sides from disagreeing about one string; a displayed `-0.00` would also read
   * as a rounding artifact in a system that has none.
   */
  const signed = wireAmount.startsWith('-');
  const negative = signed && wireAmount !== '-0';
  const digits = signed ? wireAmount.slice(1) : wireAmount;
  // Pad so there is always at least one major digit: "5" must render "0.05", not ".05".
  const padded = digits.padStart(MINOR_UNIT_EXPONENT + 1, '0');

  const major = padded.slice(0, -MINOR_UNIT_EXPONENT);
  const fraction = padded.slice(-MINOR_UNIT_EXPONENT);

  return `${negative ? '-' : ''}${major}.${fraction}`;
}
