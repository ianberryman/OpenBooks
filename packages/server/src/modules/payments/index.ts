/**
 * Payments and allocation (OB-064; ROADMAP D-34, D-37, D-39, D-40).
 *
 * Allocation is the single mechanism by which anything reduces what is
 * outstanding. Everything else in M3 — aging, the subledger-agreement property,
 * a document's `part_paid` status — is an aggregation over the rows this module
 * writes, which is why the reasoning is recorded here rather than left to be
 * inferred from the queries.
 *
 * ## A payment and an allocation are two different facts (D-37)
 *
 * A payment is an amount of money that moved. An allocation is a statement about
 * what that money settles. Nothing requires them to be equal when the payment is
 * recorded, and an unallocated remainder is a **credit balance on the contact**,
 * applicable later.
 *
 * That models what actually happens rather than what would be tidy: a deposit
 * arrives before anyone has decided what it settles, a customer rounds up, one
 * transfer pays three invoices. Requiring a payment to apply in full would make
 * all three unrecordable, and the workaround people reach for — a suspense journal
 * posted by hand — is exactly the un-auditable move a subledger exists to replace.
 *
 * ## The asymmetry, which is the point
 *
 * **Over-allocating a document is refused** (C3) and **over-paying is fine** (C4).
 * The first is a claim that an invoice has been settled twice, which puts the
 * subledger out of agreement with the ledger; the second is money in the bank with
 * nothing yet decided about it, which is an ordinary Tuesday.
 *
 * Refusing the first is not a constraint the schema can hold — it compares a `SUM`
 * across sibling rows against a `SUM` across another table's — so it is a locking
 * read and a recomputation, in `allocate.ts`. That file is where to look.
 *
 * ## An allocation posts no journal
 *
 * By the time one is recorded, both sides are already in the ledger: the payment's
 * journal debited the bank and credited the control account. A second posting here
 * would double-count, and a subledger that double-counts is precisely the failure
 * spec §11 names subledger agreement as an invariant to catch.
 *
 * The consequence is that an allocation is an ordinary mutable row. Un-applying is
 * a delete, and voiding a payment deletes the allocations it made — because the
 * money did not move, so nothing it settled is settled, and outstanding is a sum
 * over these rows rather than a column anyone could correct.
 *
 * ## Files
 *
 * - `payments.service.ts` — record, get, list, update, void
 * - `allocations.service.ts` — apply a payment, a credit note or a vendor credit;
 *   un-apply one
 * - `allocate.ts` — the mechanism, and C3's lock
 * - `settlement-discount.ts` — the settlement-discount journal + allocation
 *   (D-106), shared so bank clearing and Pay Bills' issue path cannot drift (D-112)
 * - `payments.repository.ts` / `allocations.repository.ts` — data access
 *
 * ## The control accounts
 *
 * Receiving £100 debits the bank and credits the receivables control account, so a
 * payment cannot be recorded without naming that account. Which account it is comes
 * from the org's accounting settings (`modules/settings`), which also supplies
 * `SubledgerSide` — the receivable/payable split a payment's direction chooses, a
 * document's table is, and an allocation may never cross. The account-code
 * convention this module shipped with (`1100`, `2010`) is gone: D-23 makes chart
 * templates opt-in, so an org that declined one could not record a payment.
 *
 * There are no routes: `/v1` for everything M3 adds is OB-067.
 */

export {
  getPayment,
  listPayments,
  recordPayment,
  updatePayment,
  voidPayment,
} from './payments.service';

export {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  deleteAllocation,
} from './allocations.service';

/**
 * `applyAllocations` and its `AllocationSource` — the mechanism itself, exported
 * for Cash application's `'discount'` kind (ROADMAP D-106).
 *
 * `modules/banking/clearing` reuses it directly for a `discount` clearing entry:
 * post the discount journal, then apply it as a `'discount'`-kind source, so
 * `outstanding` reaches zero through the same mechanism a payment or a credit note
 * uses rather than a second, bespoke settlement path. Everything else in this
 * module reaches `applyAllocations` from `payments.service.ts` and
 * `allocations.service.ts`, inside the package; this is the one sanctioned
 * cross-module caller.
 *
 * `deleteAllocationsForDiscountJournal` is the same caller's undo half —
 * `voidPayment`'s `deleteAllocationsForPayment`, for the third source.
 */
export { applyAllocations } from './allocate';
export type { AllocationSource } from './allocate';
export { deleteAllocationsForDiscountJournal } from './allocations.repository';

/**
 * The settlement-discount posting itself (ROADMAP D-112), exported so Pay Bills'
 * issue path can reach the same journal shape `modules/banking/clearing`'s
 * `discount` entry posts, rather than a second implementation of it.
 */
export { postSettlementDiscount } from './settlement-discount';
export type { PostSettlementDiscountInput } from './settlement-discount';
