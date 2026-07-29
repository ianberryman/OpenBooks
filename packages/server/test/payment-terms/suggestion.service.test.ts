import { describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { approveBill, createBill } from '../../src/modules/bills';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import {
  computePaymentTerm,
  createPaymentTerm,
  suggestDiscount,
} from '../../src/modules/payment-terms';
import { allocatePayment, recordPayment } from '../../src/modules/payments';
import { updateDiscountAccounts } from '../../src/modules/settings';
import type { AccountFixture, TestDatabase } from '../db';
import { newUuid, uuidToBuffer } from '../db';
import type { ActorFixture } from './support';
import { actorIn, useServiceDatabase } from './support';

/**
 * `suggestDiscount` (OB-138; ROADMAP D-79, D-106, D-108).
 *
 * Five claims, matching the ticket:
 *
 *  1. Within the discount window, a suggestion comes back.
 *  2. Past the window, `null`.
 *  3. A simple term (no discount) is `null` — nothing to suggest, ever.
 *  4. The amount is exactly what `computePaymentTerm` would compute against the
 *     same base — this file adds no second arithmetic.
 *  5. An org that has not nominated a usable discount account is `null` — there
 *     is nowhere to post the confirmed discount, so nothing is offered.
 *
 * Plus two more this ticket's own rule needs proving: the discount base switches
 * from the document total to what remains once a document is partially settled,
 * and the shared primitive answers identically on the AP side (D-108).
 */
const db = useServiceDatabase();

function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

async function insertContact(
  testDb: TestDatabase,
  orgId: Buffer,
  input: {
    readonly displayName: string;
    readonly isCustomer?: boolean;
    readonly isVendor?: boolean;
    readonly defaultPaymentTermId?: string;
  },
): Promise<string> {
  const uuid = newUuid();
  await testDb.app
    .insertInto('contacts')
    .values({
      id: uuidToBuffer(uuid),
      org_id: orgId,
      display_name: input.displayName,
      is_customer: input.isCustomer === true ? 1 : 0,
      is_vendor: input.isVendor === true ? 1 : 0,
      default_payment_term_id:
        input.defaultPaymentTermId === undefined ? null : uuidToBuffer(input.defaultPaymentTermId),
    })
    .execute();
  return uuid;
}

/** Everything an approved invoice needs, plus the org's discount-given account. */
interface ArScene {
  readonly actor: ActorFixture;
  readonly income: AccountFixture;
  readonly discountGiven: AccountFixture;
  readonly bank: AccountFixture;
  readonly date: string;
}

async function arScene(): Promise<ArScene> {
  const actor = await actorIn(db);
  const period = await db.factories.fiscalPeriod({ orgId: actor.orgId });
  const [receivable, income, discountGiven, bank] = await Promise.all([
    db.factories.account({
      orgId: actor.orgId,
      code: '1100',
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '5000',
      name: 'Sales discounts given',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '1000',
      name: 'Bank',
      type: 'asset',
      normalBalance: 'debit',
    }),
  ]);
  await db.factories.controlAccounts({ orgId: actor.orgId, receivableId: receivable.id });

  return { actor, income, discountGiven, bank, date: period.startDate };
}

/** Everything an approved bill needs, plus the org's discount-received account. */
interface ApScene {
  readonly actor: ActorFixture;
  readonly expense: AccountFixture;
  readonly discountReceived: AccountFixture;
  readonly date: string;
}

async function apScene(): Promise<ApScene> {
  const actor = await actorIn(db);
  const period = await db.factories.fiscalPeriod({ orgId: actor.orgId });
  const [payable, expense, discountReceived] = await Promise.all([
    db.factories.account({
      orgId: actor.orgId,
      code: '2000',
      name: 'Accounts payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '6000',
      name: 'Office supplies',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: actor.orgId,
      code: '4500',
      name: 'Purchase discounts received',
      type: 'revenue',
      normalBalance: 'credit',
    }),
  ]);
  await db.factories.controlAccounts({ orgId: actor.orgId, payableId: payable.id });

  return { actor, expense, discountReceived, date: period.startDate };
}

describe('an in-window suggestion (invoice, D-79/D-106)', () => {
  it('returns the discount, its deadline, and the nominated discount-given account', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      s.actor.ctx,
    );
    const contactId = await insertContact(db, s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    await updateDiscountAccounts({ discountGivenAccountId: s.discountGiven.uuid }, s.actor.ctx);

    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.income.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });

    expect(suggestion).toEqual({
      targetId: invoice.id,
      discountAmountMinor: '2000',
      deadline: computePaymentTerm(term, s.date, '100000').discountDeadline,
      accountId: s.discountGiven.uuid,
    });
  });
});

describe('out of window (invoice)', () => {
  it('answers null once asOfDate is past the discount deadline', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      s.actor.ctx,
    );
    const contactId = await insertContact(db, s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    await updateDiscountAccounts({ discountGivenAccountId: s.discountGiven.uuid }, s.actor.ctx);

    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.income.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));
    const deadline = computePaymentTerm(term, s.date, '100000').discountDeadline;
    if (deadline === null) throw new Error('A 2/10 term always computes a deadline.');

    const pastDeadline = addDays(deadline, 1);
    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: pastDeadline,
    });

    expect(suggestion).toBeNull();
  });
});

describe('a simple term (invoice)', () => {
  it('answers null — a term with no discount has nothing to suggest', async () => {
    const s = await arScene();
    const term = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, s.actor.ctx);
    const contactId = await insertContact(db, s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    await updateDiscountAccounts({ discountGivenAccountId: s.discountGiven.uuid }, s.actor.ctx);

    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.income.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });

    expect(suggestion).toBeNull();
  });
});

describe('the amount matches computePaymentTerm (D-79)', () => {
  it('never re-derives the percentage — same base, same figure', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: '3/15 Net 45', netDays: 45, discountRatePpm: 30_000, discountWindowDays: 15 },
      s.actor.ctx,
    );
    const contactId = await insertContact(db, s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    await updateDiscountAccounts({ discountGivenAccountId: s.discountGiven.uuid }, s.actor.ctx);

    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '333300',
              accountId: s.income.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });
    const expected = computePaymentTerm(term, s.date, '333300');

    expect(suggestion?.discountAmountMinor).toBe(expected.discountAmountMinor);
    expect(suggestion?.deadline).toBe(expected.discountDeadline);
  });
});

describe('no usable discount account nominated (invoice, D-107)', () => {
  it('answers null — there is nowhere the confirmed discount could post', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      s.actor.ctx,
    );
    const contactId = await insertContact(db, s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    // Deliberately no `updateDiscountAccounts` call.

    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.income.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });

    expect(suggestion).toBeNull();
  });
});

describe('the discount base once a document is partially settled', () => {
  it('prices the discount off what remains, not off the original total', async () => {
    const s = await arScene();
    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      s.actor.ctx,
    );
    const contactId = await insertContact(db, s.actor.orgId, {
      displayName: 'Acme Ltd',
      isCustomer: true,
      defaultPaymentTermId: term.id,
    });
    await updateDiscountAccounts({ discountGivenAccountId: s.discountGiven.uuid }, s.actor.ctx);

    const invoice = await withContext(s.actor.ctx, () =>
      createInvoice(
        {
          contactId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.income.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveInvoice(invoice.id, s.actor.ctx));

    const payment = await withContext(s.actor.ctx, () =>
      recordPayment(
        { direction: 'received', contactId, date: s.date, amount: '60000', accountId: s.bank.uuid },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () =>
      allocatePayment(
        payment.id,
        { allocations: [{ targetType: 'invoice', targetId: invoice.id, amount: '60000' }] },
        s.actor.ctx,
      ),
    );

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'invoice',
      targetId: invoice.id,
      asOfDate: s.date,
    });

    // 2% of the 40000 still outstanding, not of the original 100000 total.
    expect(suggestion?.discountAmountMinor).toBe('800');
  });
});

describe('the AP mirror (bill, D-108)', () => {
  it('answers a suggestion against the discount-received account', async () => {
    const s = await apScene();
    const term = await createPaymentTerm(
      { name: '2/10 Net 30', netDays: 30, discountRatePpm: 20_000, discountWindowDays: 10 },
      s.actor.ctx,
    );
    const vendorId = await insertContact(db, s.actor.orgId, {
      displayName: 'Supplier Co',
      isVendor: true,
      defaultPaymentTermId: term.id,
    });
    await updateDiscountAccounts(
      { discountReceivedAccountId: s.discountReceived.uuid },
      s.actor.ctx,
    );

    const bill = await withContext(s.actor.ctx, () =>
      createBill(
        {
          contactId: vendorId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '50000',
              accountId: s.expense.uuid,
            },
          ],
        },
        s.actor.ctx,
      ),
    );
    await withContext(s.actor.ctx, () => approveBill(bill.id, s.actor.ctx));

    const suggestion = await suggestDiscount(s.actor.ctx, {
      targetType: 'bill',
      targetId: bill.id,
      asOfDate: s.date,
    });

    expect(suggestion).toEqual({
      targetId: bill.id,
      discountAmountMinor: '1000',
      deadline: computePaymentTerm(term, s.date, '50000').discountDeadline,
      accountId: s.discountReceived.uuid,
    });
  });
});

/** `YYYY-MM-DD` plus `n` calendar days, UTC — mirrors `compute-term.ts`'s own arithmetic. */
function addDays(date: string, n: number): string {
  const [year, month, day] = date.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`A calendar date was not in YYYY-MM-DD form: ${date}`);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + n));
  return shifted.toISOString().slice(0, 10);
}
