/**
 * Expenses: employee reimbursements, entered as bills (initiative M, OB-177;
 * ROADMAP D-M2).
 *
 * An employee expense **is** an `ap_documents` bill (`document_type='bill'`)
 * whose contact carries `is_employee` rather than `is_vendor` — not a fourth
 * document type, and not a new table. `expenses.service.ts` is
 * `bills.service.ts` cloned with two swaps only (`requireVendor` →
 * `requireEmployee`, `bills.*` → `expenses.*` permissions); the entire
 * posting path — `approveDocument`, `journalSides`, `toPostJournalInput` — is
 * `createBill`'s own, reused verbatim. Read `ap-documents.service.ts` in
 * `../bills` for that machinery and the lock order at approval.
 *
 * ## Surface
 *
 * | Operation                        | Permission          |
 * | --------------------------------- | ------------------- |
 * | `createExpense(input, ctx)`       | `expenses.write`     |
 * | `getExpense(id, ctx)`             | `expenses.read`      |
 * | `listExpenses(query, ctx)`        | `expenses.read`      |
 * | `updateExpense(id, input, ctx)`   | `expenses.write`     |
 * | `discardExpense(id, ctx)`         | `expenses.write`     |
 * | `approveExpense(id, ctx)`         | `expenses.approve`   |
 *
 * `expenses.approve` is the one place this surface is not a bill-for-bill
 * copy of `bills.service.ts`: entry is separated from approval, the
 * separation-of-duties split `disbursements.issue` makes for Pay Bills
 * (D-109). There is no `voidExpense` and no `expenses.void` in the catalog —
 * the correction after approval is a vendor credit against the same contact,
 * or `voidBill`, because the row this module writes is a bill in every sense
 * the schema can see.
 *
 * ## What this module does not do
 *
 * It writes no journal directly (`approveDocument` calls `postJournal`), and
 * it owns no table of its own beyond the one query that genuinely differs
 * from AP's: `expenses.repository.ts`'s `selectExpensesPage`, which joins
 * `contacts` and filters `is_employee = 1` so `listExpenses` and `listBills`
 * stay clean mirrors of each other (D-M8).
 *
 * There are no routes here. Transport is `transport/routes/expenses.ts`.
 */
export {
  approveExpense,
  createExpense,
  discardExpense,
  getExpense,
  listExpenses,
  updateExpense,
} from './expenses.service';
