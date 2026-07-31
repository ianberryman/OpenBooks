import type { CreateBillRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { createBankAccount } from '../../src/modules/banking';
import { approveBill, createBill, getBill, listBills } from '../../src/modules/bills';
import {
  buildPendingPayment,
  cancelPendingPayment,
  issuePendingPayment,
  setCheckOutput,
} from '../../src/modules/pay-bills';
import type { Check, CheckOutput } from '../../src/modules/pay-bills';
import type { ApScene } from './support';
import { sceneIn, useServiceDatabase, withContext } from './support';

/**
 * A `CheckOutput` that records what it was asked to emit instead of rendering a
 * PDF through `storageProvider()` — this suite's environment configures neither
 * that nor the logger the default implementation needs. `check-output.ts`'s own
 * header names this exact shape as the intended use of `setCheckOutput`.
 */
function capturingCheckOutput(): CheckOutput & { readonly emitted: Check[] } {
  const emitted: Check[] = [];
  return {
    emitted,
    emit: (check: Check) => {
      emitted.push(check);
      return Promise.resolve({});
    },
  };
}

/**
 * `committed` on a bill read (D-68 surfaced onto `billSchema`/`billSummarySchema`).
 *
 * `queue-invariants.test.ts` proves `committedTotals`'s own arithmetic; this suite
 * is the wiring on the other side — that `getBill` and `listBills` echo the exact
 * number the Pay Bills window would show for the same bill, computed the same way
 * (only an `open` intent counts), and never persisted.
 */
const db = useServiceDatabase();

let s: ApScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

function simpleBill(overrides: Partial<CreateBillRequest> = {}): CreateBillRequest {
  return {
    contactId: s.vendorUuid,
    issueDate: s.date,
    dueDate: '2026-02-15',
    taxMode: 'exclusive',
    lines: [
      {
        description: 'Widgets',
        quantity: '1',
        unitAmount: '100000',
        accountId: s.expenseUuid,
      },
    ],
    ...overrides,
  };
}

/** A registered bank account in `s`'s org, for `buildPendingPayment`'s `bankAccountId`. */
async function bankAccountUuidIn(scene: ApScene): Promise<string> {
  const bank = await db.factories.account({
    orgId: scene.orgId,
    code: '1010',
    name: 'Checking',
    type: 'asset',
    normalBalance: 'debit',
  });

  return withContext(scene.ctx, async () => {
    const account = await createBankAccount({ accountId: bank.uuid, name: 'Checking' }, scene.ctx);
    return account.id;
  });
}

async function approvedBill(scene: ApScene, overrides: Partial<CreateBillRequest> = {}) {
  return withContext(scene.ctx, async () => {
    const draft = await createBill(simpleBill(overrides), scene.ctx);
    return approveBill(draft.id, scene.ctx);
  });
}

describe('a bill with no pending payment', () => {
  it('reports committed as 0 on both getBill and listBills', async () => {
    const bill = await approvedBill(s);
    expect(bill.committed).toBe('0');

    const read = await withContext(s.ctx, () => getBill(bill.id, s.ctx));
    expect(read.committed).toBe('0');

    const page = await withContext(s.ctx, () => listBills({}, s.ctx));
    const summary = page.items.find((item) => item.id === bill.id);
    expect(summary?.committed).toBe('0');
  });
});

describe('a bill with an open pending payment', () => {
  it('reports the queued amount on getBill and listBills (D-68)', async () => {
    const bankAccountId = await bankAccountUuidIn(s);
    const bill = await approvedBill(s);

    await withContext(s.ctx, () =>
      buildPendingPayment(
        {
          contactId: s.vendorUuid,
          bankAccountId,
          rail: 'check',
          intents: [{ billId: bill.id, payAmount: '40000' }],
        },
        s.ctx,
      ),
    );

    const read = await withContext(s.ctx, () => getBill(bill.id, s.ctx));
    expect(read.committed).toBe('40000');
    // `committed` is reserved, not applied — settlement is untouched (D-64).
    expect(read.settlement).toEqual({ allocated: '0', outstanding: '100000' });

    const page = await withContext(s.ctx, () => listBills({}, s.ctx));
    const summary = page.items.find((item) => item.id === bill.id);
    expect(summary?.committed).toBe('40000');
  });
});

describe('a pending payment that has been issued', () => {
  it('no longer counts toward committed once it is a real Payment', async () => {
    setCheckOutput(capturingCheckOutput());

    const bankAccountId = await bankAccountUuidIn(s);
    const bill = await approvedBill(s);

    const pending = await withContext(s.ctx, () =>
      buildPendingPayment(
        {
          contactId: s.vendorUuid,
          bankAccountId,
          rail: 'check',
          intents: [{ billId: bill.id, payAmount: '100000' }],
        },
        s.ctx,
      ),
    );

    expect((await withContext(s.ctx, () => getBill(bill.id, s.ctx))).committed).toBe('100000');

    const outcome = await withContext(s.ctx, () =>
      issuePendingPayment(pending.id, { date: s.date }, s.ctx),
    );
    expect(outcome.status).toBe('issued');

    // Materialised into a real Payment: the bill is now settled, not merely
    // reserved, and `committed` — which only ever counted the `open` intent —
    // has nothing left to count.
    const read = await withContext(s.ctx, () => getBill(bill.id, s.ctx));
    expect(read.committed).toBe('0');
    expect(read.settlement).toEqual({ allocated: '100000', outstanding: '0' });

    const page = await withContext(s.ctx, () => listBills({}, s.ctx));
    const summary = page.items.find((item) => item.id === bill.id);
    expect(summary?.committed).toBe('0');
  });
});

describe('cancelling the pending payment', () => {
  it('frees the committed amount back to 0', async () => {
    const bankAccountId = await bankAccountUuidIn(s);
    const bill = await approvedBill(s);

    const pending = await withContext(s.ctx, () =>
      buildPendingPayment(
        {
          contactId: s.vendorUuid,
          bankAccountId,
          rail: 'check',
          intents: [{ billId: bill.id, payAmount: '40000' }],
        },
        s.ctx,
      ),
    );

    expect((await withContext(s.ctx, () => getBill(bill.id, s.ctx))).committed).toBe('40000');

    await withContext(s.ctx, () => cancelPendingPayment(pending.id, s.ctx));

    const read = await withContext(s.ctx, () => getBill(bill.id, s.ctx));
    expect(read.committed).toBe('0');

    const page = await withContext(s.ctx, () => listBills({}, s.ctx));
    const summary = page.items.find((item) => item.id === bill.id);
    expect(summary?.committed).toBe('0');
  });
});
