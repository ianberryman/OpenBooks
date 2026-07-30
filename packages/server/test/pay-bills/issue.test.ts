import { beforeEach, describe, expect, it } from 'vitest';

import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  getBill,
} from '../../src/modules/bills';
import {
  buildPendingPayment,
  cancelPendingPayment,
  getPendingPayment,
  issuePendingPayment,
  issuePendingPayments,
  setCheckOutput,
} from '../../src/modules/pay-bills';
import { uuidToBuffer } from '../db';
import {
  accountBalance,
  capturingCheckOutput,
  serviceSceneIn,
  useServiceDatabase,
  withContext,
  type ServiceScene,
} from './support';

/**
 * The happy-path issue (OB-117, A): the only gate test that reaches a
 * *successful* `issuePendingPayment`, and load-bearing for it.
 *
 * `issue.service.ts` resolves a pending payment's `bank_account_id` — a
 * `bank_accounts.id` — to the ledger account `recordPayment` actually credits
 * (`bank_accounts.account_id`, D-46). Passing the wrong one through would make
 * `recordPayment` receive a `bank_accounts.id` as an `accounts.id`, which
 * `postJournal` cannot find and throws `NotFoundError('account')` for. Nothing in
 * `queue.service.ts`'s own suite reaches issue at all, so this file is the one
 * place that regression would surface.
 *
 * Every call below runs inside `withContext`: approving a document and issuing a
 * payment both post through `postJournal`, and `assertPostable` (the period lock)
 * reads the *ambient* context rather than the parameter every service also takes
 * (spec §4 forbids threading `orgId` through a signature) — `test/bills/support.ts`
 * states the same requirement for `approveBill`.
 */
const db = useServiceDatabase();

let s: ServiceScene;

beforeEach(async () => {
  s = await serviceSceneIn(db);
  // The default `CheckOutput` renders a PDF through `storageProvider()` and logs
  // through `getConfig()`, neither configured in this suite's environment — see
  // `capturingCheckOutput`'s own header.
  setCheckOutput(capturingCheckOutput());
});

describe('issuing a pending payment end to end', () => {
  it('posts one payment against the bank ledger account, settles a discount, and applies a vendor credit', async () => {
    const checks = capturingCheckOutput();
    setCheckOutput(checks);

    await withContext(s.ctx, async () => {
      const bill1 = await createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Widgets',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.expense.uuid,
            },
          ],
        },
        s.ctx,
      );
      await approveBill(bill1.id, s.ctx);

      const bill2 = await createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Freight',
              quantity: '1',
              unitAmount: '60000',
              accountId: s.expense.uuid,
            },
          ],
        },
        s.ctx,
      );
      await approveBill(bill2.id, s.ctx);

      // An approved vendor credit, fully unapplied, for exactly what bill2 will
      // still owe once its own payAmount allocation lands (D-39).
      const vendorCredit = await createVendorCredit(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Return credit',
              quantity: '1',
              unitAmount: '50000',
              accountId: s.expense.uuid,
            },
          ],
        },
        s.ctx,
      );
      await approveVendorCredit(vendorCredit.id, s.ctx);

      const pending = await buildPendingPayment(
        {
          contactId: s.vendorUuid,
          bankAccountId: s.bankAccountUuid,
          rail: 'check',
          intents: [
            {
              billId: bill1.id,
              // 970.00 by check, plus a 30.00 settlement discount — together the
              // whole of bill1's 1000.00.
              payAmount: '97000',
              discountAmount: '3000',
              discountAccountId: s.discountReceived.uuid,
            },
            {
              billId: bill2.id,
              // 100.00 by check; the vendor credit covers the remaining 500.00 of
              // bill2's 600.00.
              payAmount: '10000',
              appliedVendorCreditId: vendorCredit.id,
            },
          ],
        },
        s.ctx,
      );

      const outcome = await issuePendingPayment(pending.id, { date: s.date }, s.ctx);

      // The fix, proved: issue resolved `bank_accounts.account_id` (the ledger
      // account) rather than `bank_accounts.id` itself, so `recordPayment` found an
      // account and posted. Regressing to the bare `bank_accounts.id` makes this
      // throw `NotFoundError('account')` before any of the assertions below run.
      expect(outcome.status).toBe('issued');
      expect(outcome.paymentId).not.toBeNull();
      // The first check ever drawn on this bank account's register (D-111).
      expect(outcome.checkNumber).toBe('1');
      expect(outcome.error).toBeNull();

      // The bank ledger account is credited for the net cash actually paid —
      // 970.00 + 100.00 = 1070.00 — never for the bills' combined 1600.00 gross.
      expect(await accountBalance(db.app, s.bank.id)).toBe(-107_000n);
      // Payables control nets to zero: both bills are fully settled between the
      // payment, the discount, and the vendor credit.
      expect(await accountBalance(db.app, s.payable.id)).toBe(0n);
      // The discount posted to the nominated discount-received account, not
      // anywhere else — the whole point of D-112's `discountAccountId`.
      expect(await accountBalance(db.app, s.discountReceived.id)).toBe(-3_000n);
      // Net expense recognised: 1000.00 + 600.00 − 500.00 (the vendor credit) =
      // 1100.00 — a sanity check that nothing landed on the wrong side.
      expect(await accountBalance(db.app, s.expense.id)).toBe(110_000n);

      // bill1 carries the discount-kind `ap_allocations` row `postSettlementDiscount`
      // wrote — the third source (`discount_journal_id`) `chk_ap_allocations_one_source`
      // permits (D-106). Read it through `getBill`'s single-document projection on
      // purpose: this is the regression guard for the bug this suite first surfaced,
      // where `ap-documents.service.ts#toAllocation` only branched on
      // `payment_id`/`vendor_credit_id` and threw `InternalError` on a discounted bill
      // (the AR mirror was `invoices/projection.ts#toAllocations`). Both now project
      // the discount source, so a discounted document reads individually.
      const readBill1 = await getBill(bill1.id, s.ctx);
      expect(readBill1.settlement.outstanding).toBe('0');
      expect(readBill1.status).toBe('paid');
      expect(readBill1.allocations.some((allocation) => allocation.sourceType === 'discount')).toBe(
        true,
      );

      const readBill2 = await getBill(bill2.id, s.ctx);
      expect(readBill2.settlement.outstanding).toBe('0');
      expect(readBill2.status).toBe('paid');

      const readPending = await getPendingPayment(pending.id, s.ctx);
      expect(readPending.status).toBe('issued');
      expect(readPending.issuedPaymentId).toBe(outcome.paymentId);

      // The check number landed on the payment's own reference, drawn from
      // `check_number_sequences` for this bank account.
      const paymentRow = await db.app
        .selectFrom('payments')
        .select(['reference', 'journal_id'])
        .where('id', '=', uuidToBuffer(outcome.paymentId ?? ''))
        .executeTakeFirst();
      expect(paymentRow?.reference).toBe('1');
      expect(paymentRow?.journal_id).not.toBeNull();

      // The printable artifact carries the same check number and the net cash
      // amount — not the bills' gross.
      expect(checks.emitted).toHaveLength(1);
      expect(checks.emitted[0]).toMatchObject({ checkNumber: 1n, amountMinor: 107_000n });
    });
  });

  it('issues each pending payment atomically: a bad one fails without rolling back a good one', async () => {
    await withContext(s.ctx, async () => {
      const goodBill = await createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'Paper', quantity: '1', unitAmount: '15000', accountId: s.expense.uuid },
          ],
        },
        s.ctx,
      );
      await approveBill(goodBill.id, s.ctx);

      const badBill = await createBill(
        {
          contactId: s.vendorUuid,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'Ink', quantity: '1', unitAmount: '20000', accountId: s.expense.uuid },
          ],
        },
        s.ctx,
      );
      await approveBill(badBill.id, s.ctx);

      const goodPending = await buildPendingPayment(
        {
          contactId: s.vendorUuid,
          bankAccountId: s.bankAccountUuid,
          rail: 'check',
          intents: [{ billId: goodBill.id, payAmount: '15000' }],
        },
        s.ctx,
      );
      const badPending = await buildPendingPayment(
        {
          contactId: s.vendorUuid,
          bankAccountId: s.bankAccountUuid,
          rail: 'check',
          intents: [{ billId: badBill.id, payAmount: '20000' }],
        },
        s.ctx,
      );
      // Cancelled, not issued — a pending payment in any state but `open` is what
      // `issuePendingPayment` refuses (`pending_payment_not_open`), and cancelling
      // is the cheapest way to reach that state without a second issue.
      await cancelPendingPayment(badPending.id, s.ctx);

      const result = await issuePendingPayments(
        { pendingPaymentIds: [goodPending.id, badPending.id], date: s.date },
        s.ctx,
      );

      const goodOutcome = result.outcomes.find(
        (outcome) => outcome.pendingPaymentId === goodPending.id,
      );
      const badOutcome = result.outcomes.find(
        (outcome) => outcome.pendingPaymentId === badPending.id,
      );

      expect(goodOutcome).toMatchObject({ status: 'issued' });
      expect(goodOutcome?.paymentId).not.toBeNull();
      expect(badOutcome).toMatchObject({
        status: 'failed',
        paymentId: null,
        error: 'pending_payment_not_open',
      });

      // The good one actually issued — not rolled back by the bad one's failure,
      // because each ran in its own transaction (`issue.service.ts`'s header, G2).
      const readGoodBill = await getBill(goodBill.id, s.ctx);
      expect(readGoodBill.settlement.outstanding).toBe('0');
      expect(readGoodBill.status).toBe('paid');

      // The bad one never touched the ledger: its bill is exactly as it was.
      const readBadBill = await getBill(badBill.id, s.ctx);
      expect(readBadBill.settlement.outstanding).toBe('20000');
      expect(readBadBill.status).toBe('approved');

      const readBadPending = await getPendingPayment(badPending.id, s.ctx);
      expect(readBadPending.status).toBe('cancelled');
      expect(readBadPending.issuedPaymentId).toBeNull();
    });
  });
});
