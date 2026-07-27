/**
 * Tax rates — the per-org rate list (OB-066; ROADMAP D-35).
 *
 * A rate is a name, a percentage, and the account tax posts to. A document line
 * carries at most one, and the document declares whether its unit prices already
 * include it. Compound rates, multi-component rates (GST+PST), and jurisdiction
 * rules are out of M3 by D-35: they are a subsystem, not a field, and scoping them
 * here would make M3 a tax milestone with invoicing attached.
 *
 * The representation and the arithmetic are `packages/shared-types/src/tax/` and
 * are not reimplemented here — `rate.ts` for why a rate is parts per million
 * rather than basis points (8.875% is the case that decides it), `compute.ts` for
 * the two rounding points and what C5's "identical journals" does and does not
 * cover. This module is storage, validation, and lifecycle.
 *
 * ## Surface
 *
 * | Operation                        | Permission        |
 * | -------------------------------- | ----------------- |
 * | `createTaxRate(input, ctx)`      | `tax_rates.write` |
 * | `getTaxRate(id, ctx)`            | `tax_rates.read`  |
 * | `listTaxRates(query, ctx)`       | `tax_rates.read`  |
 * | `updateTaxRate(id, input, ctx)`  | `tax_rates.write` |
 * | `archiveTaxRate(id, ctx)`        | `tax_rates.write` |
 * | `unarchiveTaxRate(id, ctx)`      | `tax_rates.write` |
 * | `deleteTaxRate(id, ctx)`         | `tax_rates.write` |
 *
 * The list returns one bounded page and an opaque cursor (D-21), keyed on
 * `(created_at, id)` — the general ordering, and the one this list has to use
 * rather than merely may, because `name` is mutable and a rate has no immutable
 * code to sort on the way the chart of accounts does (D-27).
 *
 * `(input, ctx)` and `ctx` as the source of the org follow the rest of the service
 * layer: spec §4 forbids an org as a loose parameter, so there is no signature here
 * into which another org's id could be passed. Nothing takes a transaction —
 * `src/db/transaction-scope.ts` propagates one ambiently.
 *
 * There are no routes. Transport is OB-067.
 *
 * ## Four decisions worth reading before changing anything here
 *
 * **The percentage is create-only, and there is no path to changing it.** D-35 and
 * `updateTaxRateRequestSchema` argue why; `updateTaxRate` records where it is
 * enforced, which is three independent places — the schema has no `percentage`,
 * `TaxRatePatch` has no rate field so an offending statement does not typecheck,
 * and `updateTaxRateRow` names the three columns it may set. The short version:
 * a document's tax was computed from the rate once and posted to an immutable
 * journal, so a rate that changed would restate documents the customer already
 * holds, and the ledger would stop agreeing with the invoice. A rate change is
 * also not a correction — when VAT moves from 17.5% to 20% both are true, of
 * different dates, and one row that silently became 20% cannot say which an
 * invoice was raised at. Correcting a mistake is a new rate plus an archive.
 *
 * **Archive is for what is in use; delete is for what never was.** The same shape
 * `deleteAccount` and the dimensions service take, and the guarantee is the
 * database's: `fk_ar_document_lines_tax_rate` and `fk_ap_document_lines_tax_rate`
 * are `ON DELETE RESTRICT`, so a cited rate cannot be removed no matter what this
 * service believes. `deleteTaxRate`'s pre-checks are a better message — they can
 * say whether it is a receivable or a payable that cites it, which errno 1451
 * cannot — and `deleteTaxRateRow` translates the errno into the same token, so
 * losing the race is invisible rather than a 500. Delete exists at all because
 * archiving is not equivalent: `uq_tax_rates_org_name` covers archived rows, so
 * without it a setup typo would hold its name forever, and the create-only
 * percentage would make every mistyped rate permanent.
 *
 * **A tax account is a liability or an asset — never revenue, expense, or
 * equity.** The wire contract calls the field "the liability account", and taken
 * literally that is one type; this service accepts two, and the extra one is
 * deliberate rather than lax. Tax collected on a sale is owed to the authority and
 * is a liability. Tax paid on a purchase is *reclaimable from* the authority, and
 * real charts model that either as a contra-liability or as an asset called `VAT
 * recoverable` — D-35 gives a rate one account, so an org reclaiming input tax
 * holds two rates, and refusing the asset side would refuse a correct chart.
 *
 * What both have in common is the property that matters: the balance is a claim
 * outstanding until the return is filed and settled, which is a balance-sheet
 * position. Revenue and expense are refused because tax posted there lands in
 * profit — turnover overstated by exactly the amount owed, or the mirror image —
 * and nothing in the trial balance would show it had happened, since the entry is
 * still balanced. Equity is refused because a settlement balance is not a claim by
 * an owner. The account must also be active, checked when the rate is defined
 * rather than when an invoice using it is approved, which is the point at which it
 * would be a customer waiting. `fk_tax_rates_account` cannot express any of this —
 * MySQL has no CHECK that reads another table — which is why `0005_subledger`
 * names this service as the place it lives.
 *
 * **Zero-rated and exempt are different things, and the schema already tells them
 * apart, so this service must not collapse them.** A zero-rated supply carries a
 * rate whose percentage is `0`: an ordinary row here, created by
 * `createTaxRate({ percentage: '0', … })`, cited by the line's `tax_rate_id`, with
 * `tax_amount_minor = 0`. An exempt supply carries no rate at all: `tax_rate_id IS
 * NULL`, which `chk_ar_document_lines_tax_needs_rate` permits precisely because
 * tax of zero needs no rate to attribute it to.
 *
 * The decision, therefore, is a decision *not* to add anything: no `isExempt`
 * flag, no `kind` enum, no rule rejecting 0% as meaningless. A nullable
 * `tax_rate_id` already carries "exempt", and a second way to say it is how two
 * sources of truth start. What this service does owe the distinction is that a 0%
 * rate creates without complaint — and that is the cheap-now, expensive-later
 * part. Refuse 0% and an org records zero-rated sales as no-rate lines, at which
 * point the two are indistinguishable in the data: a UK VAT return puts
 * zero-rated supplies in box 6 and leaves exempt ones out, and after a year of
 * filed returns there is nothing left to reconstruct which was which from. The
 * rate primitive agrees — `ZERO_TAX_RATE` and `isZeroTaxRate` exist in
 * `shared-types/src/tax/rate.ts` — so this is one behaviour across the two halves
 * rather than a local choice.
 *
 * ## `appliesTo`, and where it is enforced
 *
 * A rate posts to one account, so an org reclaiming input VAT holds a sales rate
 * and a purchases rate rather than one rate with two accounts. `applies_to` is the
 * column that keeps a bill's rate picker from offering the sales one
 * (`0005_subledger`; OB-066a closed the OB-060/OB-061 disagreement that had this
 * module refusing anything but `both`).
 *
 * **This module stores it and does not enforce it.** The rule "a bill may not cite
 * a sales-only rate" belongs where a document line first cites a rate —
 * `resolveLines` in `modules/invoices` and `modules/bills` — for the reason the
 * archived-rate check lives there too: that is the moment a wrong rate becomes a
 * wrong posting, and it is where a `validation_failed` can name the line. Checking
 * here would mean checking on every read, and re-checking at approval would refuse
 * a document priced while the rate was still unrestricted.
 *
 * The list filter is a *usability* predicate rather than an equality — asking for
 * `sales` returns the unrestricted rates too, since a sales document may cite one.
 * See `selectTaxRatesPage`.
 */

export type {
  CreateTaxRateRequest,
  ListTaxRatesQuery,
  TaxRateApplicability,
  TaxRatePage,
  TaxRateResponse,
  UpdateTaxRateRequest,
} from '@openbooks/shared-types';
export { TAX_RATE_APPLICABILITIES, TAX_RATE_NAME_MAX_LENGTH } from '@openbooks/shared-types';

export {
  archiveTaxRate,
  createTaxRate,
  deleteTaxRate,
  getTaxRate,
  listTaxRates,
  unarchiveTaxRate,
  updateTaxRate,
} from './tax-rates.service';
