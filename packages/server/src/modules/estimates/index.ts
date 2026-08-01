/**
 * Estimates (initiative M, OB-175…176; ROADMAP D-M3, D-M4, D-M6, D-M7).
 *
 * ## Surface
 *
 * | Operation                                | Permission                          |
 * | ----------------------------------------- | ------------------------------------ |
 * | `createEstimate(input, ctx)`              | `estimates.write`                    |
 * | `getEstimate(id, ctx)`                    | `estimates.read`                     |
 * | `listEstimates(query, ctx)`               | `estimates.read`                     |
 * | `updateEstimate(id, input, ctx)`          | `estimates.write`                    |
 * | `discardEstimate(id, ctx)`                | `estimates.write`                    |
 * | `approveEstimate(id, ctx)`                | `estimates.write`                    |
 * | `convertEstimateToInvoice(id, ctx)`       | `estimates.write` + `invoices.write` |
 * | `estimatesSummary(query, ctx)`            | `estimates.read`                     |
 *
 * The compound entry is not this module checking two permissions: converting
 * calls the ordinary `createInvoice`, which checks `invoices.write` on its own —
 * the same composition `approveArDocument` has with `postJournal`'s
 * `journals.post`.
 *
 * ## What an estimate is, and the one thing it never does
 *
 * An estimate is the AR mirror of a purchase order: a **non-posting
 * pre-document** (D-M3, D-92) that carries lines and its own gapless number, but
 * never touches a journal. `status` — `draft` / `approved` / `converted` — is a
 * **stored** column, not derived the way an AR document's is (D-38 does not
 * apply here, because there is no journal or allocation for a status to be
 * derived from): `draft` while `sequence_number IS NULL`, `approved` once
 * `approveEstimate` allocates one, `converted` once `convertEstimateToInvoice`
 * has produced an invoice.
 *
 * Approving allocates the estimate's number and stamps `approved_at` — nothing
 * else, because there is no journal to post alongside it (contrast an AR
 * document's approve, which does both in the same transaction). Converting
 * builds a `CreateInvoiceRequest` from the estimate's header and priced lines
 * and calls `createInvoice`, then records the resulting invoice id on the
 * estimate — convert-once, guarded by a `FOR UPDATE` read and a
 * `converted_invoice_id IS NULL` check, exactly as approving an AR document
 * guards against a second journal.
 *
 * ## No `requireCustomer` guard
 *
 * The AR side of this codebase does not gate document creation on a contact
 * flag — `createInvoice` only checks the contact exists — and `createEstimate`
 * follows that exactly. This is a pre-existing asymmetry with AP's
 * `requireVendor`, not something introduced here.
 *
 * ## No dimension tags on a line (D-M7)
 *
 * A purchase order or an estimate line carries no dimension tags in v1 — a
 * converted draft invoice can have them added before it is approved. So an
 * estimate line's `dimensionValueIds` on the wire is always `[]`, and there is
 * no `estimate_line_dimensions` table for it to come from.
 *
 * There are no routes here; transport is `transport/routes/estimates.ts`.
 */

export {
  approveEstimate,
  convertEstimateToInvoice,
  createEstimate,
  discardEstimate,
  getEstimate,
  listEstimates,
  updateEstimate,
} from './estimates.service';
export { estimatesSummary } from './summary.service';
