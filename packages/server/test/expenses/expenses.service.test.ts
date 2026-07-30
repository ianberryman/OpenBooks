import type { CreateExpenseRequest } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { toWireError } from '../../src/errors';
import { approveExpense, createExpense, getExpense } from '../../src/modules/expenses';
import { bufferToUuid } from '../db';
import type { ExpenseScene } from './support';
import {
  accountBalance,
  memberOf,
  nonEmployeeContactIn,
  sceneIn,
  useServiceDatabase,
  withContext,
} from './support';

/**
 * The expense lifecycle (initiative M, OB-177; ROADMAP D-M2, D-M8).
 *
 * An employee expense is an `ap_documents` bill against an employee contact, and
 * `createBill`'s own posting path — `approveDocument`, `journalSides`,
 * `toPostJournalInput` — is reused verbatim (`test/bills/*.test.ts` proves that
 * machinery once). What is specific to expenses and worth proving again here is
 * narrow: the contact guard is `requireEmployee` rather than `requireVendor`, and
 * `approveExpense` is gated by its own `expenses.approve` key rather than
 * `expenses.write` — the separation-of-duties split D-M8's permission table
 * describes.
 */
const db = useServiceDatabase();

let s: ExpenseScene;

beforeEach(async () => {
  s = await sceneIn(db);
});

function simpleExpense(overrides: Partial<CreateExpenseRequest> = {}): CreateExpenseRequest {
  return {
    contactId: s.employeeUuid,
    issueDate: s.date,
    dueDate: s.date,
    taxMode: 'exclusive',
    lines: [
      {
        description: 'Client dinner',
        quantity: '1',
        unitAmount: '15000',
        accountId: s.expenseUuid,
      },
    ],
    ...overrides,
  };
}

async function wireErrorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => toWireError(thrown),
  );
}

describe('creating an expense', () => {
  it('succeeds against a contact carrying isEmployee (D-M2)', async () => {
    const expense = await withContext(s.ctx, () => createExpense(simpleExpense(), s.ctx));

    expect(expense).toMatchObject({
      contactId: s.employeeUuid,
      status: 'draft',
      documentNumber: null,
      journalId: null,
    });
    expect(expense.totals).toEqual({ net: '15000', tax: '0', gross: '15000' });
  });

  it('refuses a contact that is not marked as an employee', async () => {
    const vendor = await nonEmployeeContactIn(db, s.orgId, 'Not an employee');

    const error = await wireErrorOf(
      withContext(s.ctx, () =>
        createExpense(simpleExpense({ contactId: bufferToUuid(vendor) }), s.ctx),
      ),
    );

    expect(error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'contact_is_not_an_employee' },
    });
  });
});

describe('approving an expense', () => {
  it('posts a balanced journal — debit expense, credit the payables control account', async () => {
    const created = await withContext(s.ctx, () => createExpense(simpleExpense(), s.ctx));
    const approved = await withContext(s.ctx, () => approveExpense(created.id, s.ctx));

    expect(approved.documentNumber).not.toBeNull();
    expect(approved.status).toBe('approved');
    expect(approved.journalId).not.toBeNull();

    // Debited: the expense account carries a positive (debit) balance for the
    // line amount. Credited: the payables control account carries a matching
    // negative (credit) balance — a reimbursement owed, not yet paid.
    expect(await accountBalance(db.app, s.orgId, s.expenseId)).toBe(15_000n);
    expect(await accountBalance(db.app, s.orgId, s.payableId)).toBe(-15_000n);
  });

  it('makes the expense payable: the whole gross is outstanding (D-34)', async () => {
    const created = await withContext(s.ctx, () => createExpense(simpleExpense(), s.ctx));
    const approved = await withContext(s.ctx, () => approveExpense(created.id, s.ctx));

    expect(approved.settlement).toEqual({ allocated: '0', outstanding: '15000' });

    const reread = await withContext(s.ctx, () => getExpense(created.id, s.ctx));
    expect(reread.status).toBe('approved');
  });

  /**
   * `expenses.approve` is its own permission, distinct from `expenses.write`
   * (D-M8) — the point being that entering an expense and approving it into a
   * payable are not the same act.
   *
   * The seeded roles cannot yet isolate "holds `expenses.write`, lacks
   * `expenses.approve`" precisely: `0001_tenancy.ts` deliberately defers
   * `ap_only`'s `expenses.read`/`.write` grant and `approver`'s
   * `expenses.approve` grant "until the M services enforce them" (its own
   * comment, next to the `purchase_orders`/`estimates` grants it defers the
   * same way) — which is this ticket, landing in the same wave as the
   * service. Wiring the grant is the orchestrator's step, not this service's,
   * so this asserts what is provable against the roles seeded today: a caller
   * with no `expenses.write` and no `expenses.approve` (`read_only`, which
   * holds `expenses.read` only) is refused approval and the refusal names
   * `expenses.approve` — proving the gate exists and is checked by name.
   * Once the role grant lands, the sharper "holds write, lacks approve" case
   * belongs in `permissions.test.ts` alongside the rest of the D-M8 matrix.
   */
  it('is refused for a caller with no expenses.approve', async () => {
    const created = await withContext(s.ctx, () => createExpense(simpleExpense(), s.ctx));
    const reader = await memberOf(db, s, 'readOnly');

    expect(
      await wireErrorOf(withContext(reader, () => approveExpense(created.id, reader))),
    ).toMatchObject({
      code: 'permission_denied',
      status: 403,
      details: { permission: 'expenses.approve' },
    });
  });
});
