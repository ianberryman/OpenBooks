/**
 * Pay Bills (initiative G, OB-109…118; ROADMAP D-63…D-69, D-109…D-112).
 *
 * Paying bills as a first-class function rather than a side effect of the Money
 * screen: a batch queue that posts no ledger effect until money actually moves, a
 * treasury step that releases it, and a double-payment guard that lives where the
 * duplicate check is cut.
 *
 * ## The queue is not a draft payment (D-64)
 *
 * A `Payment` in this system is money that moved — `journal_id` is never null, there
 * is no draft state (D-37/D-38) — so the queued-but-unpaid state cannot be one. It
 * is a separate, mutable `pending_payment` that posts no journal and materialises
 * into a real `Payment` per vendor only at issue (D-65). That separation is what
 * lets cash stay put until the check is cut, and it carries the separation of duties
 * (D-109): building the queue needs `pending_payments.write`, releasing it needs
 * `disbursements.issue`.
 *
 * ## One payment per vendor (D-63)
 *
 * A `Payment` carries one contact and allocations refuse to cross contacts
 * (`assertSameContact`), so a batch Pay Bills run fans out into one payment — and
 * one check — per vendor. Issue is therefore atomic per payment, not per run: one
 * vendor's bad ACH detail must not roll back the checks already cut.
 *
 * ## Files
 *
 * - `queue.service.ts` — OB-111: build, edit, cancel the queue; list payable bills
 *   with `committed`/`availableToPay` (D-68). Posts no journal.
 * - `issue.service.ts` — OB-112: materialise a pending payment into a `Payment`
 *   (via `recordPayment` + `postSettlementDiscount` + the check register).
 * - `check-register.repository.ts` — the gapless per-bank-account check counter (D-14).
 * - `check-output.ts` — the `CheckOutput` seam (D-111): a default PDF check+stub,
 *   swappable for an external printer/handoff.
 * - `vendor-details.service.ts` — a vendor's ACH/wire disbursement details (D-67).
 * - `rail-disbursements.service.ts` — the list-by-rail read an external ACH/wire
 *   system pulls (D-110).
 * - `queue.repository.ts` — data access.
 */

export {
  buildPendingPayment,
  cancelPendingPayment,
  getPendingPayment,
  listPayableBills,
  listPendingPayments,
  payBills,
  updatePendingPayment,
} from './queue.service';
export type { PendingPaymentFilter } from './queue.service';

export { issuePendingPayment, issuePendingPayments } from './issue.service';

export {
  getVendorDisbursementDetails,
  updateVendorDisbursementDetails,
} from './vendor-details.service';

export { listDisbursementsByRail } from './rail-disbursements.service';

/**
 * The `CheckOutput` seam (D-111), exported so a deployment can swap the default PDF
 * renderer for a handoff to an external check printer, and so tests can install a
 * capturing double. The default is reached lazily by the issue service; nothing
 * else needs `checkOutput()`.
 */
export { checkOutput, setCheckOutput } from './check-output';
export type { Check, CheckOutput } from './check-output';
