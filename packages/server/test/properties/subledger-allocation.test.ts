import type { DocumentLineInput } from '@openbooks/shared-types';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RequestContext } from '../../src/context';
import { approveBill, createBill, getBill } from '../../src/modules/bills';
import { approveInvoice, createInvoice, getInvoice } from '../../src/modules/invoices';
import { allocatePayment, getPayment, recordPayment } from '../../src/modules/payments';
import type { SubledgerSide } from '../../src/modules/settings';
import { toWireError } from '../../src/errors';

import {
  agingAt,
  controlAccountOf,
  controlBalance,
  createSubledgerScene,
  dateAfterEpoch,
  signedFor,
  useSubledgerDatabase,
  withContext,
  type SubledgerScene,
} from './subledger-support';

/**
 * Allocation arithmetic (OB-071; M3 C3 and C4, ROADMAP D-34, D-37).
 *
 * D-37's asymmetry is the thing under test, and it is one sentence with two halves
 * that are easy to conflate: **over-allocating a document is refused, over-paying is
 * fine and lands as credit on the contact.** A service that enforced only the first
 * half would make a customer who rounded their payment up unrecordable; one that
 * enforced only the second would let a £100 receipt clear £300 of invoices, which
 * creates money.
 *
 * So one property, run end to end over generated amounts, that walks the whole of
 * what a person does with a payment that does not exactly match an invoice:
 *
 *  1. Over-allocate the invoice — refused, and **nothing moved**. The state check is
 *     the half that matters: a refusal that had already written one row of a batch
 *     would leave the caller to work out which half happened, and the whole reason
 *     `createAllocationsRequestSchema` takes a batch is that it must not.
 *  2. Allocate more of the payment than the payment holds, split across two
 *     documents each of which has room — refused for a *different* reason
 *     (`source_over_allocated`), because the two limits are not the same limit.
 *  3. Apply the other contact's payment — refused. `assertSameContact` is not a
 *     schema constraint and is easy to lose; without it two contacts' rows are each
 *     individually wrong while the total stays right, which is a report that ties
 *     and lies.
 *  4. Settle the first document exactly. The surplus is now credit on the contact:
 *     the payment says so, and the aging report says so as a negative in `current`.
 *  5. Apply that credit to the second document, later. It reconciles — the second
 *     document's outstanding falls by exactly the credit, the payment is fully
 *     applied, and the control account is where the subledger says it is at every
 *     step.
 *
 * Both sides, because a payables allocation is a different table and a different
 * pair of columns, and the two are written twice on purpose (`0005_subledger`).
 *
 * ## What is asserted after each refusal, and why it is not decoration
 *
 * Every refusal is followed by a re-read of the target's outstanding, the payment's
 * unapplied amount and the control account. A `PreconditionFailedError` thrown after
 * a partial write is indistinguishable from one thrown before any write if the only
 * thing asserted is the error — and the transaction that would have to roll back is
 * one this module opens itself.
 */
const harness = useSubledgerDatabase();

const RUNS = 12;

/** Shrinking here rebuilds an org and four documents per attempt. */
const SHRINKING_BUDGET_MS = 180_000;

interface AllocationCase {
  readonly side: SubledgerSide;
  readonly startMonth: number;
  /** Cents on the first document, and on the second. Both strictly positive. */
  readonly firstUnit: number;
  readonly secondUnit: number;
  readonly quantity: number;
  /**
   * Chooses the over-payment, resolved against the *second* document's gross once
   * both documents exist.
   *
   * Not a free amount, and the reason is step 2. `sourceExhausted` can only be
   * reached by a batch whose lines each fit their own target and whose total
   * exceeds the payment, so the second document must have room for one cent more
   * than the surplus. Generated freely, that held about half the time and the step
   * silently did nothing on the other half — a refusal that is sometimes not
   * attempted is a refusal that is sometimes not tested.
   */
  readonly surplusSeed: number;
  /** How far past the invoice the allocation of the surplus is dated. */
  readonly laterOffset: number;
}

const allocationCaseArb: fc.Arbitrary<AllocationCase> = fc.record({
  side: fc.constantFrom<SubledgerSide>('receivable', 'payable'),
  startMonth: fc.integer({ min: 2, max: 12 }),
  firstUnit: fc.integer({ min: 1, max: 200_00 }),
  // At least two cents, so the second document has room for a surplus of at least
  // one and step 2 always has a batch to refuse.
  secondUnit: fc.integer({ min: 2, max: 200_00 }),
  quantity: fc.constantFrom(1, 2, 3),
  surplusSeed: fc.nat({ max: 100_000 }),
  laterOffset: fc.constantFrom(0, 1, 45),
});

describe('allocation arithmetic (OB-071, C3, C4, D-37)', () => {
  it(
    'refuses over-allocation, banks over-payment as credit, and reconciles it later',
    async () => {
      await fc.assert(
        fc.asyncProperty(allocationCaseArb, async (input) => {
          const scene = await createSubledgerScene(harness, {
            startMonth: input.startMonth,
            contacts: 2,
          });
          const { ctx } = scene;
          const [payer, stranger] = contactPair(scene);
          const control = controlAccountOf(scene, input.side);
          const issueDate = dateAfterEpoch(0);
          const settled = dateAfterEpoch(30);
          const later = dateAfterEpoch(30 + input.laterOffset);

          const first = await approvedDocument(scene, input, payer, input.firstUnit, issueDate);
          const second = await approvedDocument(scene, input, payer, input.secondUnit, issueDate);

          const firstGross = first.gross;
          const secondGross = second.gross;
          // `1 <= surplus <= secondGross - 1`, so the payment always over-pays
          // (D-37's credit) and the second document always has room for one cent
          // more than the credit (step 2's refusal).
          const surplus = 1n + BigInt(input.surplusSeed % Number(secondGross - 1n));
          const amount = firstGross + surplus;

          const payment = await withContext(ctx, () =>
            recordPayment(
              {
                direction: input.side === 'receivable' ? 'received' : 'made',
                contactId: payer,
                date: issueDate,
                amount: amount.toString(),
                accountId: scene.accounts.bank,
              },
              ctx,
            ),
          );

          // The ledger before anything is applied. Allocation posts no journal
          // (D-37), so this figure must not move again for the rest of the run —
          // which is asserted after every step below, and is the claim that would
          // fail first if an allocation ever started writing to the ledger.
          const ledgerBalance = await controlBalance(ctx, control, later);
          expect(ledgerBalance).toBe(signedFor(input.side, firstGross + secondGross - amount));

          // 1 — over-allocating one document. C3.
          const overAllocation = await refusal(ctx, () =>
            allocatePayment(
              payment.id,
              {
                allocations: [
                  {
                    targetType: targetOf(input.side),
                    targetId: first.id,
                    amount: (firstGross + 1n).toString(),
                  },
                ],
              },
              ctx,
            ),
          );
          expect(overAllocation).toMatchObject({
            code: 'precondition_failed',
            status: 412,
            precondition: 'document_over_allocated',
          });
          await expectUntouched(scene, input, payment.id, [first, second], ledgerBalance, later);

          // 2 — applying more of the payment than it holds, with room on both
          // targets. A different limit, and `sourceExhausted` is the only thing that
          // can catch it: each line individually fits.
          const sourceOver = await refusal(ctx, () =>
            allocatePayment(
              payment.id,
              {
                allocations: [
                  {
                    targetType: targetOf(input.side),
                    targetId: first.id,
                    amount: firstGross.toString(),
                  },
                  {
                    targetType: targetOf(input.side),
                    targetId: second.id,
                    amount: (surplus + 1n).toString(),
                  },
                ],
              },
              ctx,
            ),
          );
          expect(sourceOver).toMatchObject({
            code: 'precondition_failed',
            status: 412,
            precondition: 'source_over_allocated',
          });
          await expectUntouched(scene, input, payment.id, [first, second], ledgerBalance, later);

          // 3 — the other contact's money. Not a schema constraint, so nothing but a
          // test holds it (`assertSameContact`).
          const strangersPayment = await withContext(ctx, () =>
            recordPayment(
              {
                direction: input.side === 'receivable' ? 'received' : 'made',
                contactId: stranger,
                date: issueDate,
                amount: firstGross.toString(),
                accountId: scene.accounts.bank,
              },
              ctx,
            ),
          );
          const crossed = await refusal(ctx, () =>
            allocatePayment(
              strangersPayment.id,
              {
                allocations: [
                  {
                    targetType: targetOf(input.side),
                    targetId: first.id,
                    amount: '1',
                  },
                ],
              },
              ctx,
            ),
          );
          expect(crossed).toMatchObject({
            code: 'precondition_failed',
            status: 412,
            precondition: 'allocation_contact_mismatch',
          });

          // The stranger's receipt is itself a posting, so the control account has
          // moved — by exactly that receipt and by nothing the refused allocation
          // did. Stated rather than re-read blindly, because "the ledger did not
          // move" is the claim the rest of this run rests on and it would be
          // satisfied by re-baselining after every step.
          const ledgerNow = await controlBalance(ctx, control, later);
          expect(ledgerNow).toBe(ledgerBalance - signedFor(input.side, firstGross));

          // 4 — settling the first document exactly, leaving the surplus as credit.
          await withContext(ctx, () =>
            allocatePayment(
              payment.id,
              {
                date: settled,
                allocations: [
                  {
                    targetType: targetOf(input.side),
                    targetId: first.id,
                    amount: firstGross.toString(),
                  },
                ],
              },
              ctx,
            ),
          );

          expect(await outstandingOf(ctx, input.side, first.id)).toBe(0n);
          expect(await statusOf(ctx, input.side, first.id)).toBe('paid');

          // C4's first half: the remainder is a credit *on the contact*, computed
          // from the allocations and never stored (D-34, D-37).
          const banked = await withContext(ctx, () => getPayment(payment.id, ctx));
          expect(BigInt(banked.settlement.outstanding)).toBe(surplus);

          // And the report agrees, which is the part that ties C4 to C2: the credit
          // is money already in the control account, so aging carries it as a
          // negative in `current` and the total still equals the ledger.
          const midway = await agingAt(ctx, input.side, settled);
          const payerRow = midway.rows.find((row) => row.contactId === payer);
          if (payerRow === undefined) throw new Error('The payer vanished from the aging report.');
          expect(BigInt(payerRow.amounts.total)).toBe(secondGross - surplus);
          expect(BigInt(midway.totals.total)).toBe(
            signedFor(input.side, await controlBalance(ctx, control, settled)),
          );

          // 5 — the credit applied later. C4's second half: "applicable later, and
          // applying it reconciles". The `date` is the settlement's own, which is
          // what makes an aging report as at a day before it still show the credit.
          const applied = surplus;
          await withContext(ctx, () =>
            allocatePayment(
              payment.id,
              {
                date: later,
                allocations: [
                  {
                    targetType: targetOf(input.side),
                    targetId: second.id,
                    amount: applied.toString(),
                  },
                ],
              },
              ctx,
            ),
          );

          expect(await outstandingOf(ctx, input.side, second.id)).toBe(secondGross - applied);
          const drawn = await withContext(ctx, () => getPayment(payment.id, ctx));
          expect(BigInt(drawn.settlement.outstanding)).toBe(0n);

          // The ledger has not moved once through all five steps. Allocation records
          // which document a movement was for; the movement was the payment's own
          // journal, and a second posting here would double-count it (`allocate.ts`).
          expect(await controlBalance(ctx, control, later)).toBe(ledgerNow);

          const closing = await agingAt(ctx, input.side, later);
          expect(BigInt(closing.totals.total)).toBe(
            signedFor(input.side, await controlBalance(ctx, control, later)),
          );
        }),
        { numRuns: RUNS },
      );
    },
    SHRINKING_BUDGET_MS,
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApprovedDocument {
  readonly id: string;
  readonly gross: bigint;
}

function targetOf(side: SubledgerSide): 'invoice' | 'bill' {
  return side === 'receivable' ? 'invoice' : 'bill';
}

function contactPair(scene: SubledgerScene): readonly [string, string] {
  const [first, second] = scene.contacts;
  if (first === undefined || second === undefined) {
    throw new Error('The allocation scene needs two contacts.');
  }
  return [first, second];
}

/**
 * One approvable document of the side's target type, taxed.
 *
 * Taxed rather than plain, because the amount an allocation is checked against is
 * `net + tax` and a document with no tax makes a check that used the net alone
 * indistinguishable from a correct one.
 */
async function approvedDocument(
  scene: SubledgerScene,
  input: AllocationCase,
  contactId: string,
  unit: number,
  issueDate: string,
): Promise<ApprovedDocument> {
  const { ctx } = scene;
  const lines: DocumentLineInput[] = [
    {
      description: 'Work',
      quantity: String(input.quantity),
      unitAmount: String(unit),
      accountId: input.side === 'receivable' ? scene.accounts.income : scene.accounts.expense,
      taxRateId: rateFor(scene, input.side),
    },
  ];

  const body = {
    contactId,
    issueDate,
    dueDate: issueDate,
    taxMode: 'exclusive' as const,
    lines,
  };

  const created = await withContext(ctx, () =>
    input.side === 'receivable' ? createInvoice(body, ctx) : createBill(body, ctx),
  );
  const approved = await withContext(ctx, () =>
    input.side === 'receivable' ? approveInvoice(created.id, ctx) : approveBill(created.id, ctx),
  );

  return { id: created.id, gross: BigInt(approved.totals.gross) };
}

function rateFor(scene: SubledgerScene, side: SubledgerSide): string {
  const rate = scene.rates[side === 'receivable' ? 0 : 2];
  if (rate === undefined) throw new Error('The scene has no rate for this side.');
  return rate;
}

/**
 * The wire form of whatever `body` threw, or a failure if it did not throw.
 *
 * The `precondition` token is lifted out of `details`, because that is where
 * `PreconditionFailedError` puts it and every refusal in this file is a different
 * *token* under the same `code`. Asserting the code alone would let a run pass in
 * which over-allocating and applying somebody else's money were refused for each
 * other's reason.
 */
async function refusal(
  ctx: RequestContext,
  body: () => Promise<unknown>,
): Promise<{ readonly code: string; readonly status: number; readonly precondition: unknown }> {
  const thrown = await withContext(ctx, body).then(
    () => undefined,
    (error: unknown) => error,
  );

  if (thrown === undefined) {
    throw new Error(
      'This allocation was accepted, and every caller of this helper expects it to have been ' +
        'refused.',
    );
  }

  const wire = toWireError(thrown);
  const details: Record<string, unknown> = wire.details ?? {};
  return { code: wire.code, status: wire.status, precondition: details['precondition'] };
}

/**
 * Nothing moved: not the documents, not the payment, not the ledger.
 *
 * The point of asserting all four after a refusal rather than only the error: a
 * batch that wrote its first line and threw on its second would produce exactly the
 * same `PreconditionFailedError`, and the caller would be left to work out which
 * half happened — the failure `createAllocationsRequestSchema` names.
 */
async function expectUntouched(
  scene: SubledgerScene,
  input: AllocationCase,
  paymentId: string,
  documents: readonly ApprovedDocument[],
  ledgerBalance: bigint,
  asOf: string,
): Promise<void> {
  const { ctx } = scene;

  for (const document of documents) {
    expect(await outstandingOf(ctx, input.side, document.id)).toBe(document.gross);
  }

  const payment = await withContext(ctx, () => getPayment(paymentId, ctx));
  expect(payment.settlement.allocated).toBe('0');
  expect(payment.allocations).toHaveLength(0);

  expect(await controlBalance(ctx, controlAccountOf(scene, input.side), asOf)).toBe(ledgerBalance);
}

async function outstandingOf(
  ctx: RequestContext,
  side: SubledgerSide,
  id: string,
): Promise<bigint> {
  const view = await withContext(ctx, () =>
    side === 'receivable' ? getInvoice(id, ctx) : getBill(id, ctx),
  );
  return BigInt(view.settlement.outstanding);
}

async function statusOf(ctx: RequestContext, side: SubledgerSide, id: string): Promise<string> {
  const view = await withContext(ctx, () =>
    side === 'receivable' ? getInvoice(id, ctx) : getBill(id, ctx),
  );
  return view.status;
}
