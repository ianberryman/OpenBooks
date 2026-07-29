/**
 * Accounts payable: bills and vendor credits (OB-063; ROADMAP D-34 to D-39).
 *
 * What this business owes, and what its vendors owe back. Structurally the mirror
 * of AR (OB-062) — same lifecycle, same tax arithmetic, same allocation
 * mechanism — and two things about it are genuinely different. Both are below.
 *
 * ## Surface
 *
 * | Operation                                  | Permission              |
 * | ------------------------------------------ | ----------------------- |
 * | `createBill(input, ctx)`                   | `bills.write`           |
 * | `getBill(id, ctx)`                         | `bills.read`            |
 * | `listBills(query, ctx)`                    | `bills.read`            |
 * | `updateBill(id, input, ctx)`               | `bills.write`           |
 * | `discardBill(id, ctx)`                     | `bills.write`           |
 * | `approveBill(id, ctx)`                     | `bills.write`           |
 * | `voidBill(id, input, ctx)`                 | `bills.void`            |
 * | `createVendorCredit(input, ctx)`           | `vendor_credits.write`  |
 * | `getVendorCredit(id, ctx)`                 | `vendor_credits.read`   |
 * | `listVendorCredits(query, ctx)`            | `vendor_credits.read`   |
 * | `updateVendorCredit(id, input, ctx)`       | `vendor_credits.write`  |
 * | `discardVendorCredit(id, ctx)`             | `vendor_credits.write`  |
 * | `approveVendorCredit(id, ctx)`             | `vendor_credits.write`  |
 * | `voidVendorCredit(id, input, ctx)`         | `vendor_credits.write`  |
 *
 * Approving takes the document's *write* permission rather than a code of its own,
 * because the catalog is fixed (spec §5) and holds no `bills.approve`. Voiding a
 * bill takes `bills.void`, which the catalog does hold; voiding a vendor credit
 * takes `vendor_credits.write`, because the catalog holds no `vendor_credits.void`
 * — the same asymmetry AR has between `invoices.void` and credit notes.
 *
 * `(input, ctx)` and `ctx` as the source of the org follow the rest of the service
 * layer: spec §4 forbids an org as a loose parameter, so there is no signature here
 * into which another org's id could be passed. Nothing takes a transaction —
 * `src/db/transaction-scope.ts` propagates one ambiently, which is what lets
 * `withIdempotency(spec, () => approveBill(id))` be one unit of work.
 *
 * There are no routes. Transport is OB-067.
 *
 * ## The lifecycle, and where the irreversible line is (D-38)
 *
 * `draft → approved → (part_paid → paid)`, with `void` alongside. **Only approval
 * posts a journal**, and it is the one irreversible step: before it a document is
 * editable and discardable exactly as a journal draft is (D-16, D-19), and after
 * it the ledger has been told.
 *
 * Nothing about that lifecycle is stored as a status. The state is read from the
 * two journal columns and the arithmetic:
 *
 *     draft      journal_id IS NULL
 *     approved   journal_id IS NOT NULL, void_journal_id IS NULL, nothing allocated
 *     part_paid  … and some of the total allocated
 *     paid       … and all of it
 *     void       void_journal_id IS NOT NULL
 *
 * `chk_ap_documents_approved` ties the number and the journal together, so
 * "approved" cannot be claimed without a journal to point at. A stored status would
 * be a third copy of a fact the journal columns already carry, and the first thing
 * to drift when an allocation is removed (D-34, D-38).
 *
 * Voiding is a reversing journal recorded in `void_journal_id`, never a deletion
 * (D-16, C7). The document, its number and its original journal all remain
 * visible; a voided bill that vanished would make the gapless sequence a lie.
 *
 * ## The two things AP does not share with AR
 *
 * **1. `reference` holds the vendor's own invoice number, and a duplicate is
 * refused.** D-36: "on a bill it holds the vendor's own invoice number, which is
 * the number that matters on an AP document — we did not issue it, and our
 * sequence number is only our internal handle." Two approved, un-voided bills from
 * one vendor quoting one number is the classic duplicate-entry mistake, and it is
 * the one that costs money — it is how a supplier gets paid twice, and neither
 * total nor the trial balance shows anything wrong. `approveBill` refuses it. The
 * full argument, including why "warn" was not available and why drafts and voided
 * bills are deliberately exempt, is on `assertNoDuplicateReference`.
 *
 * **2. The journal runs the other way.** A bill debits what was bought and
 * **credits** accounts payable, where an invoice debits receivables. Getting that
 * backwards is invisible in a total — the journal still balances and the trial
 * balance still sums to zero — and obvious on a balance sheet, where payables would
 * carry a debit balance and the business would appear to be owed money by every
 * supplier it owes. `journalSides` is the one place that decision is made, and
 * `test/bills/direction.test.ts` asserts the *signed* control-account balance
 * because that is the only assertion the mistake can fail.
 *
 * ## What this module does not do
 *
 * It never writes `journals` or `journal_lines`: approving calls `postJournal` and
 * voiding calls `reverseJournal`, both of which own balance validation, the period
 * lock, and actor provenance (`openbooks/no-journal-writes`). It never writes
 * `ap_allocations` either — allocation is OB-064's, and this module only reads them
 * to compute settlement (D-34). It holds no balance and no status column, which
 * `test/schema/subledger.test.ts` asserts by reading `information_schema` and
 * finding nothing.
 *
 * ## The payables control account
 *
 * Read from the org's accounting settings (`modules/settings`), which is where the
 * nomination lives and where what changing it means is argued. This module resolves
 * it and does not decide it: an approval on an org that has nominated nothing is a
 * `payable_control_account_not_set`, naming the setting to fix rather than an
 * account code somebody would have to guess. The account-code convention this
 * module shipped with — `2010`, from the only chart template the product ships —
 * is gone, because D-23 makes templates opt-in and an org that declined one had no
 * way to approve a bill at all.
 *
 * ## The AP clerk can finish a bill (OB-093)
 *
 * `postJournal` requires `journals.post` and `reverseJournal` requires
 * `journals.reverse`. The seeded `ap_only` role (migration `0001_tenancy`) now
 * holds both, so the role that exists to enter bills can approve, void and pay
 * one — closing the gap M3 found (formerly known gap 6). The fix was the role
 * seed, not a change here; the ledger still authorizes its own writes (spec §2.4).
 * `test/bills/permissions.test.ts` asserts the completion.
 */

export {
  approveBill,
  createBill,
  discardBill,
  getBill,
  listBills,
  updateBill,
  voidBill,
} from './bills.service';

export {
  approveVendorCredit,
  createVendorCredit,
  discardVendorCredit,
  getVendorCredit,
  listVendorCredits,
  updateVendorCredit,
  voidVendorCredit,
} from './vendor-credits.service';

/**
 * OCR bill capture (initiative O, OB-186/187/188/190; ROADMAP "the pinned OCR
 * contract"): the staging area between an uploaded or emailed document and a
 * bill a human has reviewed. `capture/capture.service.ts` carries the full
 * surface and permission table; `capture/extraction.job.ts` is the event-driven
 * job both entrypoints (`api.ts`, `worker.ts`) register.
 */
export {
  createCaptureFromInbound,
  createCaptureFromUpload,
  createDraftFromCapture,
  dismissCapture,
  getBillAttachment,
  getCapture,
  listCaptures,
} from './capture/capture.service';

export type {
  DocumentExtractionDeps,
  DocumentExtractionJob,
  DocumentExtractionJobContext,
} from './capture/extraction.job';
export { DOCUMENT_EXTRACTION_QUEUE, registerDocumentExtractionJob } from './capture/extraction.job';
