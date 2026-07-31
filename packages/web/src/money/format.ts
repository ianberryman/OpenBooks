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

/**
 * Built once at module scope: a `new Intl.NumberFormat` per render is the usual reason a
 * formatting call shows up in a profile, and this one is stateless and locale-fixed, so
 * there is nothing to gain by rebuilding it.
 */
const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * `"150000"` → `"$1,500.00"`. The display projection — symbol and thousands grouping —
 * layered on top of `formatMinorUnits`, which stays the function for the exact decimal
 * string and for any caller that is not putting the amount in front of a person (a CSV
 * export, an input's default value, and so on).
 *
 * Formats through `Intl.NumberFormat`'s **string** overload, exactly as the
 * `formatMinorUnits` doc above says grouping must: `.format("1500.00")` parses the decimal
 * string itself, so the float `formatMinorUnits` exists to avoid never gets introduced at
 * the last step. `"-0"` needs no separate handling here — `formatMinorUnits` already
 * renders it `"0.00"`, and `CURRENCY_FORMATTER` has nothing left to lose the sign from.
 */
export function formatMoney(wireAmount: string): string {
  const decimal = formatMinorUnits(wireAmount);
  return CURRENCY_FORMATTER.format(decimal as Intl.StringNumericLiteral);
}

/**
 * What a person may type into an amount field: an optional sign, digits, at most one
 * decimal point, and at most `MINOR_UNIT_EXPONENT` digits after it. Either side of the
 * point may be empty — `"5."` and `".5"` are both amounts someone is in the middle of
 * typing — but not both.
 */
const DECIMAL_ENTRY_PATTERN = /^(-?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/;

/**
 * `"1500.00"` → `"150000"`. The inverse of `formatMinorUnits`, and the only way a typed
 * amount becomes a wire amount (OB-046, D-13).
 *
 * String manipulation again, for the reason the module header gives: `Math.round(Number
 * ("1.115") * 100)` is 111, because the double nearest `1.115` is below it. That is a cent
 * lost in a journal line, from a function that looks like parsing.
 *
 * **Refuses excess precision rather than rounding it.** `"1.005"` throws. This is the
 * asymmetry worth stating: the ledger has exactly one rounding point, in `allocate`, where
 * the remainder is distributed deliberately and the total is preserved. A parser that
 * rounded would be a second one — silent, per-field, and invisible in the posted entry,
 * so a user who typed three decimals would see two and never learn which way the third
 * went. Throwing puts the decision back where it belongs, with the person typing.
 */
export function toMinorUnits(entry: string): string {
  const match = DECIMAL_ENTRY_PATTERN.exec(entry.trim());
  if (match === null) {
    throw new MoneyFormatError(
      `Expected an amount with at most ${String(MINOR_UNIT_EXPONENT)} decimal places, received ` +
        `${JSON.stringify(entry)}.`,
    );
  }

  const [, sign = '', majorPart = '', fractionPart, bareFraction] = match;
  const fraction = fractionPart ?? bareFraction ?? '';

  if (fraction.length > MINOR_UNIT_EXPONENT) {
    throw new MoneyFormatError(
      `${JSON.stringify(entry)} has more than ${String(MINOR_UNIT_EXPONENT)} decimal places. ` +
        `Amounts are exact to the cent; rounding is a decision this function will not make ` +
        `on your behalf.`,
    );
  }

  const digits = `${majorPart}${fraction.padEnd(MINOR_UNIT_EXPONENT, '0')}`;
  // Canonical form: no leading zeros, and no `-0`, both of which `fromMinorString` rejects
  // on the server side of the same wire format.
  const canonical = digits.replace(/^0+(?=\d)/, '');

  return canonical === '0' ? '0' : `${sign}${canonical}`;
}

/**
 * `toMinorUnits` without the throw, for a field being typed into.
 *
 * A keystroke is not an error. `"1.0"` is unfinished rather than wrong, and a component
 * that has to `try`/`catch` on every change to discover that will eventually catch too
 * much — so the distinction between "not an amount yet" and "not an amount" is drawn once,
 * here, and `MoneyInput` reads it.
 */
export function tryToMinorUnits(entry: string): string | null {
  try {
    return toMinorUnits(entry);
  } catch (error) {
    if (error instanceof MoneyFormatError) return null;
    throw error;
  }
}
