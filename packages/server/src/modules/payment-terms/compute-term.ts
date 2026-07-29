import type { ComputedPaymentTerm } from '@openbooks/shared-types';
import { fromMinorString, ratio, scale, toMinorString } from '@openbooks/shared-types/money';

/**
 * The pure arithmetic a payment term does (OB-136; ROADMAP D-79, D-106).
 *
 * Two numbers, from three inputs: `issueDate + netDays` is the due date every
 * term has, and — when the term is *rich* (`discountRatePpm`/`discountWindowDays`
 * both set, `chk_payment_terms_discount`) — the early-pay amount and the last day
 * it may be taken. A *simple* term (both null) returns a null discount, which is
 * `computedPaymentTermSchema`'s own pairing carried down to the function that
 * fills it in.
 *
 * No database access and no permission check — this is arithmetic on values the
 * caller already holds, called from `resolveDocumentTerm`'s callers (a create
 * needing only the due date) and, later, from OB-138's suggestion (which needs
 * the discount against a real document total). Keeping it pure is what makes it
 * unit-testable without `useTestDatabase()`, unlike everything else in this
 * module.
 */

/** The three columns `computePaymentTerm` reads. A `PaymentTerm` satisfies this structurally. */
export interface PaymentTermFields {
  readonly netDays: number;
  readonly discountRatePpm: number | null;
  readonly discountWindowDays: number | null;
}

/**
 * The rate's fixed denominator, restated from `tax_rates.rate_ppm`'s own
 * convention rather than imported from `shared-types/tax`: `discountRatePpm` is a
 * different rate, over a different base (a document total, not a taxable
 * amount), and importing the tax module's constant would put an edge in the
 * dependency graph asserting a discount is built on tax — the same reason
 * `settings.repository.ts` restates `ACCOUNT_RESOURCE` rather than importing it.
 */
const DISCOUNT_RATE_DENOMINATOR = 1_000_000n;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Calendar-date arithmetic in UTC, restated from `banking/matching/dates.ts`
 * rather than imported — that function is a private helper of the matching
 * module, and reaching into another module's internals for six lines would put
 * an edge in the dependency graph this module has no business asserting. UTC
 * rather than local midnight for the reason that file gives: a calendar date
 * (`calendarDateSchema`, no `Date`) has no timezone, and a local-midnight
 * subtraction spans 23 or 25 hours across a DST boundary.
 */
function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined || Number.isNaN(day)) {
    // `calendarDateSchema` has already parsed this, whether it arrived on the
    // wire or out of `payment_terms`/`ar_documents`; a malformed value here is a
    // fault in this process, not input.
    throw new Error(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * MILLISECONDS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * `issueDate + netDays`, and — on a rich term — the discount available against
 * `documentTotalMinor` and the last day it may be taken.
 *
 * The discount is `scale(total, ratio(discountRatePpm, 1_000_000))`, mirroring
 * `exclusiveTaxRatio`'s one-multiplication-one-rounding shape exactly:
 * `rate_ppm / 1_000_000` against the *rounded* total the same way tax is taken
 * from the rounded extension (`shared-types/tax/compute.ts`), not from some
 * unrounded intermediate — there is only one total here to round from, so the
 * distinction that matters for tax (line versus document) does not arise, but
 * the single rounding point (`scale`) is the same one every other rate in this
 * system goes through.
 *
 * `documentTotalMinor` is unused and irrelevant on a simple term, and callers
 * that only need the due date (`createArDocument`, before any line exists to
 * total) may pass `'0'` — the discount fields come back null regardless, since a
 * simple term never had them to begin with.
 */
export function computePaymentTerm(
  term: PaymentTermFields,
  issueDate: string,
  documentTotalMinor: string,
): ComputedPaymentTerm {
  const dueDate = addCalendarDays(issueDate, term.netDays);

  if (term.discountRatePpm === null || term.discountWindowDays === null) {
    return { dueDate, discountAmountMinor: null, discountDeadline: null };
  }

  const total = fromMinorString(documentTotalMinor);
  const discount = scale(total, ratio(BigInt(term.discountRatePpm), DISCOUNT_RATE_DENOMINATOR));

  return {
    dueDate,
    discountAmountMinor: toMinorString(discount),
    discountDeadline: addCalendarDays(issueDate, term.discountWindowDays),
  };
}
