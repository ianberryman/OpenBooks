/**
 * AR documents: invoices and credit notes (OB-062; ROADMAP D-34, D-35, D-36, D-38,
 * D-39; acceptance C1, C6, C7, C9).
 *
 * ## Surface
 *
 * | Operation                              | Permission          |
 * | -------------------------------------- | ------------------- |
 * | `createInvoice(input, ctx)`            | `invoices.write`    |
 * | `getInvoice(id, ctx)`                  | `invoices.read`     |
 * | `listInvoices(query, ctx)`             | `invoices.read`     |
 * | `updateInvoice(id, input, ctx)`        | `invoices.write`    |
 * | `discardInvoice(id, ctx)`              | `invoices.write`    |
 * | `approveInvoice(id, ctx)`              | `invoices.write` + `journals.post` |
 * | `voidInvoice(id, input, ctx)`          | `invoices.void` + `journals.reverse` |
 * | `createCreditNote(input, ctx)`         | `credit_notes.write` |
 * | `getCreditNote(id, ctx)`               | `credit_notes.read`  |
 * | `listCreditNotes(query, ctx)`          | `credit_notes.read`  |
 * | `updateCreditNote(id, input, ctx)`     | `credit_notes.write` |
 * | `discardCreditNote(id, ctx)`           | `credit_notes.write` |
 * | `approveCreditNote(id, ctx)`           | `credit_notes.write` + `journals.post` |
 * | `voidCreditNote(id, input, ctx)`       | `credit_notes.write` + `journals.reverse` |
 *
 * The compound entries are not this module checking two permissions. Approving
 * posts through `postJournal` and voiding through `reverseJournal`, and each checks
 * its own — which is the correct design (the ledger kernel is the only writer, and
 * it authorizes its own writes) with one consequence that has to be recorded rather
 * than discovered:
 *
 * > **The seeded `ar_only` role cannot approve or void.** Its bundle is
 * > `invoices.*`, `credit_notes.*`, `payments_received.*` plus reads, and it holds
 * > neither `journals.post` nor `journals.reverse` (`0001_tenancy`). So an AR clerk
 * > can compose an invoice and not issue it. That is a *role seeding* question, not
 * > a service one — the alternatives are to add the two codes to `ar_only` and
 * > `ap_only`, or to let a document permission authorize a posting, and the second
 * > would make `journals.post` describable as "unless you go through a document".
 * > It belongs with OB-072's enforcement matrix and known gap 6. Owner, Bookkeeper
 * > and Approver are unaffected.
 *
 * `credit_notes.void` does not exist in the catalog, so voiding a credit note takes
 * `credit_notes.write` — argued on `ArDocumentKind` in `kinds.ts`.
 *
 * ## What a document is, and the two things it does not have
 *
 * **No balance** (D-34). There is no `outstanding_minor` column and nothing here
 * writes one. What is outstanding is the document's total minus the allocations
 * applied to it, computed on read, exactly as the trial balance is computed from
 * journal lines rather than from a cache. The moment a document carries its own
 * balance there are two answers to "what does this customer owe" — the subledger's
 * and the ledger's — and spec §11 makes their agreement an invariant precisely
 * because that divergence is unfalsifiable when the subledger is the thing being
 * asked.
 *
 * **No status** (D-38). `draft`, `approved`, `part_paid`, `paid` and `void` are
 * derived from two columns and a sum: `journal_id IS NULL` is a draft,
 * `void_journal_id IS NOT NULL` is void, and the rest is what has been applied
 * against the total. A stored status is a second source of truth that drifts the
 * first time an allocation is removed.
 *
 * Both absences are also asserted structurally: `test/schema` greps
 * `information_schema` for a balance or status column on these tables, so writing
 * one fails the build rather than a review.
 *
 * ## Approve is the irreversible step
 *
 * Before it, a document is editable and discardable exactly as a journal draft is
 * (D-16, D-19) — and it holds **no number**, because a number reserved by a draft
 * that was then discarded would leave a gap, and a gap in a document series is
 * indistinguishable from a deleted document (D-36 through D-14's argument).
 *
 * Approving, in one transaction: take the document's row lock, allocate the number
 * from `document_sequences` `FOR UPDATE`, post a balanced journal through
 * `postJournal`, and record the number and the journal id together —
 * `chk_ar_documents_approved` asserts `(journal_id IS NULL) = (sequence_number IS
 * NULL)`, so a half-approved document is unrepresentable rather than merely avoided.
 * The lock order and what the loser of a concurrent approval sees are documented in
 * full at the top of `ar-documents.service.ts`.
 *
 * ## Void is a reversal, never a deletion
 *
 * The document stays, with its number and its original journal, and a *second*
 * journal reverses it — recorded in `void_journal_id`, both visible (D-16, D-38,
 * C7). A voided document that vanished would make the gapless sequence a lie.
 *
 * A document with allocations against it is refused, and that rule is this module's:
 * the reversal takes the document out of what is outstanding while the allocation
 * would remain, so the payment would read as fully applied and the control account
 * would disagree with the subledger by exactly the amount applied. C2's failure,
 * caused by the operation meant to correct things.
 *
 * ## Tax and dimensions are borrowed, never re-implemented
 *
 * Tax is `shared-types/tax/compute.ts`: two rounding points per line (the extension,
 * then the tax), and the document's totals are the sums of the rounded lines rather
 * than the rate applied to a sum (D-35). Both entry modes reach the same two
 * functions, which is what makes C5 a property of the arithmetic rather than of two
 * services agreeing. Tags are `resolveTagsForNewLine` (D-18), so the refusals a tag
 * can earn are the dimensions module's rules and not a second copy of them.
 *
 * ## The receivables control account
 *
 * Read from the org's accounting settings (`modules/settings`), which owns the
 * nomination and argues what changing it means. This module resolves it and does
 * not decide it: an org that has nominated nothing gets a
 * `receivable_control_account_not_set` naming the setting to fix. The account-code
 * convention this module shipped with — the `1100` the one shipped chart template
 * uses — is gone, because D-23 makes templates opt-in and an org that declined one
 * could not invoice at all.
 *
 * There are no routes. Transport is OB-067.
 */

export {
  approveInvoice,
  createInvoice,
  discardInvoice,
  getInvoice,
  listInvoices,
  updateInvoice,
  voidInvoice,
} from './invoices.service';

export {
  approveCreditNote,
  createCreditNote,
  discardCreditNote,
  getCreditNote,
  listCreditNotes,
  updateCreditNote,
  voidCreditNote,
} from './credit-notes.service';

export { invoicesSummary } from './summary.service';
