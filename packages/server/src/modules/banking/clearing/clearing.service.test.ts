import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext } from '../../../context';
import { toWireError } from '../../../errors';
import { uuidToBuffer } from '../../../../test/db';
import {
  accountBalance,
  allocationsForInvoice,
  bankJournalIn,
  billIn,
  clearingOf,
  finalisedSessionIn,
  invoiceIn,
  journalCount,
  journalStillExists,
  memberIn,
  reversalsOf,
  sceneIn,
  statementLineIn,
  useServiceDatabase,
  type Scene,
} from '../../../../test/banking/clearing-support';

import { clearBankStatementLine, removeBankLineClearing } from './clearing.service';

/**
 * The clearing service against real MySQL (OB-081; acceptance E3, E4). Never a mock
 * and never SQLite (spec §11): the guarantees are the two unique keys on
 * `bank_line_clearings`, the ledger the difference posts to, and the org scoping
 * `tenantDb` applies — none of which a mock holds.
 *
 * E4 as an equation is the subject of `clearing.e4.test.ts`; contention is
 * `clearing.race.test.ts`. This file is the happy paths and the refusals.
 */

const db = useServiceDatabase();

let scene: Scene;
beforeEach(async () => {
  scene = await sceneIn(db);
});

function run<T>(fn: () => Promise<T>, ctx = scene.ctx): Promise<T> {
  return runInContext(ctx, fn);
}

async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(
    () => {
      throw new Error('expected a refusal, got success');
    },
    (error: unknown) => error,
  );
}

describe('post_entry', () => {
  it('creates a journal for the line and writes the clearing', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const before = await journalCount(db.app, scene.orgId);
    const result = await run(() =>
      clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
    );

    expect(result.method).toBe('post_entry');
    expect(result.clearedAmount).toBe('5000');
    expect(result.differenceAmount).toBe('0');
    expect(result.differenceAccountId).toBeNull();
    expect(result.differenceJournalId).toBeNull();
    expect(result.paymentId).toBeNull();
    expect(result.reconciliationSessionId).toBeNull();
    expect(result.clearedByUserId).toBe(scene.userUuid);

    // One journal posted; the bank ledger moved by the line and revenue took the other side.
    expect(await journalCount(db.app, scene.orgId)).toBe(before + 1);
    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(5000n);
    expect(await accountBalance(db.app, scene.revenue.id)).toBe(-5000n);
  });

  it('codes an outbound line with the bank on the credit side', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: -5000n });

    await run(() =>
      clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.expense.uuid }),
    );

    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(-5000n);
    expect(await accountBalance(db.app, scene.expense.id)).toBe(5000n);
  });
});

describe('link_entry', () => {
  it('links an entry whose bank movement equals the line, with no difference', async () => {
    const journal = await bankJournalIn(db, scene, 5000n, scene.revenue);
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const before = await journalCount(db.app, scene.orgId);
    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'link_entry',
        journalId: journal.uuid,
      }),
    );

    expect(result.method).toBe('link_entry');
    expect(result.clearedJournalId).toBe(journal.uuid);
    expect(result.clearedAmount).toBe('5000');
    expect(result.differenceAmount).toBe('0');
    expect(result.differenceJournalId).toBeNull();
    // Nothing was posted: linking says "this is that", not "post it again".
    expect(await journalCount(db.app, scene.orgId)).toBe(before);
  });

  it('posts the shortfall to the difference account (a bank charge)', async () => {
    // A manually posted receipt of £1,000; the statement shows £990 arrived.
    const journal = await bankJournalIn(db, scene, 100000n, scene.revenue);
    const line = await statementLineIn(db, scene, { amountMinor: 99000n });

    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'link_entry',
        journalId: journal.uuid,
        differenceAccountId: scene.charges.uuid,
      }),
    );

    expect(result.clearedAmount).toBe('100000');
    expect(result.differenceAmount).toBe('-1000');
    expect(result.differenceAccountId).toBe(scene.charges.uuid);
    expect(result.differenceJournalId).not.toBeNull();

    // £10 went to charges, and the bank ledger now reflects the £990 the bank moved.
    expect(await accountBalance(db.app, scene.charges.id)).toBe(1000n);
    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(99000n);
  });
});

describe('allocate_document', () => {
  it('records a payment and settles the invoice exactly', async () => {
    const invoice = await invoiceIn(db, scene, 5000n);
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoice.uuid,
      }),
    );

    expect(result.method).toBe('allocate_document');
    expect(result.paymentId).not.toBeNull();
    expect(result.clearedAmount).toBe('5000');
    expect(result.differenceAmount).toBe('0');
    // The invoice's receivable control is back to zero: raised 5000, settled 5000.
    expect(await accountBalance(db.app, scene.receivable.id)).toBe(0n);
    expect(await allocationsForInvoice(db.app, invoice.id)).toBe(1);
  });

  it('settles a bill on an outbound line', async () => {
    const bill = await billIn(db, scene, 5000n);
    const line = await statementLineIn(db, scene, { amountMinor: -5000n });

    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'allocate_document',
        targetType: 'bill',
        targetId: bill.uuid,
      }),
    );

    expect(result.clearedAmount).toBe('-5000');
    // Bill raised the payable by 5000; paying it clears the payable and the bank.
    expect(await accountBalance(db.app, scene.payable.id)).toBe(0n);
    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(-5000n);
  });

  it('leaves the shortfall outstanding on a short payment with no difference', async () => {
    const invoice = await invoiceIn(db, scene, 100000n);
    const line = await statementLineIn(db, scene, { amountMinor: 99000n });

    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoice.uuid,
      }),
    );

    expect(result.clearedAmount).toBe('99000');
    expect(result.differenceAmount).toBe('0');
    // £10 of the invoice is still owed: the receivable control carries the remainder.
    expect(await accountBalance(db.app, scene.receivable.id)).toBe(1000n);
  });

  it('writes off a bank charge while settling the whole invoice', async () => {
    const invoice = await invoiceIn(db, scene, 100000n);
    const line = await statementLineIn(db, scene, { amountMinor: 99000n });

    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoice.uuid,
        amount: '100000',
        differenceAccountId: scene.charges.uuid,
      }),
    );

    expect(result.clearedAmount).toBe('100000');
    expect(result.differenceAmount).toBe('-1000');
    expect(result.differenceJournalId).not.toBeNull();
    // Invoice fully settled, £10 expensed, bank ledger reflects the £990 received.
    expect(await accountBalance(db.app, scene.receivable.id)).toBe(0n);
    expect(await accountBalance(db.app, scene.charges.id)).toBe(1000n);
    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(99000n);
  });
});

describe('refusals', () => {
  it('refuses a post_entry into a closed period (D-45), and writes nothing', async () => {
    const closed = await db.factories.fiscalPeriod({
      orgId: scene.orgId,
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      status: 'closed',
    });
    expect(closed.status).toBe('closed');
    const line = await statementLineIn(db, scene, { amountMinor: 5000n, postedDate: '2025-01-15' });

    const before = await journalCount(db.app, scene.orgId);
    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
      ),
    );

    expect(toWireError(error)).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'period_closed' },
    });
    expect(await clearingOf(db.app, line.id)).toBeUndefined();
    expect(await journalCount(db.app, scene.orgId)).toBe(before);
  });

  it('refuses clearing a line that already carries a clearing', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });
    await run(() =>
      clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
    );

    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.expense.uuid }),
      ),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'statement_line_already_cleared' },
    });
  });

  it('refuses linking a journal another line already cleared', async () => {
    const journal = await bankJournalIn(db, scene, 5000n, scene.revenue);
    const first = await statementLineIn(db, scene, { amountMinor: 5000n });
    const second = await statementLineIn(db, scene, { amountMinor: 5000n });

    await run(() =>
      clearBankStatementLine(first.uuid, { method: 'link_entry', journalId: journal.uuid }),
    );
    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(second.uuid, { method: 'link_entry', journalId: journal.uuid }),
      ),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'journal_already_cleared' },
    });
  });

  it('refuses a difference with no account to post it to', async () => {
    const journal = await bankJournalIn(db, scene, 100000n, scene.revenue);
    const line = await statementLineIn(db, scene, { amountMinor: 99000n });

    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(line.uuid, { method: 'link_entry', journalId: journal.uuid }),
      ),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'clearing_difference_unaccounted' },
    });
    expect(await clearingOf(db.app, line.id)).toBeUndefined();
  });

  it('refuses over-allocating a document (C3), and writes nothing', async () => {
    const invoice = await invoiceIn(db, scene, 100000n);
    const line = await statementLineIn(db, scene, { amountMinor: 200000n });

    const before = await journalCount(db.app, scene.orgId);
    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(line.uuid, {
          method: 'allocate_document',
          targetType: 'invoice',
          targetId: invoice.uuid,
        }),
      ),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'document_over_allocated' },
    });
    // The payment and its journal rolled back with the refused allocation.
    expect(await clearingOf(db.app, line.id)).toBeUndefined();
    expect(await journalCount(db.app, scene.orgId)).toBe(before);
  });

  it('refuses clearing against a deactivated bank account', async () => {
    await db.app
      .updateTable('bank_accounts')
      .set({ is_active: 0 })
      .where('id', '=', scene.bankAccountId)
      .execute();
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
      ),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'bank_account_archived' },
    });
  });

  it('answers a cross-org line with a 404 (E9)', async () => {
    const otherScene = await sceneIn(db);
    const line = await statementLineIn(db, otherScene, { amountMinor: 5000n });

    const error = await caught(() =>
      run(() =>
        clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
      ),
    );
    expect(toWireError(error)).toMatchObject({ code: 'not_found', status: 404 });
  });
});

describe('undo', () => {
  it('reverses a post_entry journal rather than deleting it', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });
    const cleared = await run(() =>
      clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
    );
    const journalId = uuidToBuffer(cleared.clearedJournalId);

    await run(() => removeBankLineClearing(line.uuid, { date: scene.date }));

    expect(await clearingOf(db.app, line.id)).toBeUndefined();
    // The original journal is untouched and a reversal points at it (D-16).
    expect(await journalStillExists(db.app, journalId)).toBe(true);
    expect(await reversalsOf(db.app, journalId)).toBe(1);
    // The posting and its reversal net to zero on both accounts.
    expect(await accountBalance(db.app, scene.bankLedger.id)).toBe(0n);
    expect(await accountBalance(db.app, scene.revenue.id)).toBe(0n);
  });

  it('reverses only the difference journal of a link_entry, never the linked entry', async () => {
    const journal = await bankJournalIn(db, scene, 100000n, scene.revenue);
    const line = await statementLineIn(db, scene, { amountMinor: 99000n });
    const cleared = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'link_entry',
        journalId: journal.uuid,
        differenceAccountId: scene.charges.uuid,
      }),
    );
    const differenceJournalId = uuidToBuffer(cleared.differenceJournalId ?? '');

    await run(() => removeBankLineClearing(line.uuid, { date: scene.date }));

    expect(await clearingOf(db.app, line.id)).toBeUndefined();
    // The linked entry is not reversed — it existed before the clearing and outlives it.
    expect(await reversalsOf(db.app, journal.id)).toBe(0);
    // The difference is reversed, so charges is back to zero.
    expect(await reversalsOf(db.app, differenceJournalId)).toBe(1);
    expect(await accountBalance(db.app, scene.charges.id)).toBe(0n);
  });

  it('voids the payment of an allocate_document, restoring what was outstanding', async () => {
    const invoice = await invoiceIn(db, scene, 5000n);
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });
    const cleared = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoice.uuid,
      }),
    );
    const paymentJournalId = uuidToBuffer(cleared.clearedJournalId);

    await run(() => removeBankLineClearing(line.uuid, { date: scene.date }));

    expect(await clearingOf(db.app, line.id)).toBeUndefined();
    // Voiding reverses the payment's journal and deletes its allocation (M3's undo).
    expect(await reversalsOf(db.app, paymentJournalId)).toBe(1);
    expect(await allocationsForInvoice(db.app, invoice.id)).toBe(0);
    // The invoice is owed again in full.
    expect(await accountBalance(db.app, scene.receivable.id)).toBe(5000n);
  });

  it('refuses undo when the reversal date falls in a closed period', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });
    await run(() =>
      clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
    );
    await db.factories.fiscalPeriod({
      orgId: scene.orgId,
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      status: 'closed',
    });

    const error = await caught(() =>
      run(() => removeBankLineClearing(line.uuid, { date: '2025-01-15' })),
    );
    expect(toWireError(error)).toMatchObject({ details: { precondition: 'period_closed' } });
    // The clearing is intact — the refused reversal rolled back with it.
    expect(await clearingOf(db.app, line.id)).toBeDefined();
  });

  it('refuses undo of a clearing a finalised session counts (E6)', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });
    await run(() =>
      clearBankStatementLine(line.uuid, { method: 'post_entry', accountId: scene.revenue.uuid }),
    );
    // A session finalised over a window that includes the line's date.
    await finalisedSessionIn(db, scene, scene.date, 5000n);

    const error = await caught(() =>
      run(() => removeBankLineClearing(line.uuid, { date: scene.date })),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'reconciliation_session_already_finalised' },
    });
    expect(await clearingOf(db.app, line.id)).toBeDefined();
  });

  it('refuses undo of a line that was never cleared', async () => {
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });
    const error = await caught(() =>
      run(() => removeBankLineClearing(line.uuid, { date: scene.date })),
    );
    expect(toWireError(error)).toMatchObject({
      details: { precondition: 'statement_line_not_cleared' },
    });
  });
});

describe('permissions', () => {
  /**
   * The service's own gate is `banking.match`. A role that reads banking but cannot
   * match is refused with exactly that key — the primary gate, before any of the
   * downstream ledger work the OB-093 note in `index.ts` describes.
   */
  it('refuses a role that does not hold banking.match', async () => {
    const readOnly = await memberIn(db, scene, 'readOnly');
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const error = await caught(() =>
      run(
        () =>
          clearBankStatementLine(line.uuid, {
            method: 'post_entry',
            accountId: scene.revenue.uuid,
          }),
        readOnly,
      ),
    );
    expect(toWireError(error)).toMatchObject({
      code: 'permission_denied',
      details: { permission: 'banking.match' },
    });
  });

  /**
   * OB-093, pinned rather than papered over. `allocate_document` reaches
   * `recordPayment`, which enforces `payments_received.write` *and* posts through
   * `journals.post`. Among the seeded roles only Owner and Bookkeeper hold
   * `banking.match`, and both also hold those codes — so an allocate clearing
   * succeeds for Owner, confirming the composite gate is satisfiable. A role holding
   * `banking.match` without the ledger codes would be refused downstream; no seeded
   * role is in that position, so the refusal is pinned by the wave-2 permission
   * matrix (OB-089), not here. See the report for the full code list.
   */
  it('lets an owner clear via allocate_document (banking.match + payments + journals.post)', async () => {
    const invoice = await invoiceIn(db, scene, 5000n);
    const line = await statementLineIn(db, scene, { amountMinor: 5000n });

    const result = await run(() =>
      clearBankStatementLine(line.uuid, {
        method: 'allocate_document',
        targetType: 'invoice',
        targetId: invoice.uuid,
      }),
    );
    expect(result.paymentId).not.toBeNull();
  });
});
