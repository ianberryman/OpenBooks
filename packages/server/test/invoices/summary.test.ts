import { invoicesSummarySchema } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { invoicesSummary } from '../../src/modules/invoices';
import { bufferToUuid, newUuidBuffer, uuidToBuffer } from '../db';

import type { Scene, SceneAccount } from '../reports/support';
import { createChart, createParty, createScene, post, useReportDatabase } from '../reports/support';

/**
 * The invoices-list headline figures (OB-069 UI): total still owed, total overdue,
 * and received in the last 30 days. The AR mirror of `test/bills/summary.test.ts`;
 * see there for the arguments that hold here too.
 *
 * The point under test is not the outstanding arithmetic itself — that is
 * `selectArDocuments`, proven against the control account in `test/reports/aging.test.ts`
 * and reused here — but the three summary decisions layered on it: that a settled or
 * voided invoice contributes nothing, that "overdue" draws the same due-date line the
 * aging report's `current` bucket does (due today is not overdue), and that the received
 * figure is a 30-day window on the payment date. The fixtures insert documents
 * directly for the same reason the aging suite does: every *journal* is posted through
 * the real ledger, and the AR rows are written as the services write them — a journal
 * first, then the document carrying its id and a sequence number.
 */
const harness = useReportDatabase();

const BANK = '1000';
const RECEIVABLES = '1100';
const SALES = '4000';

/** Every figure is measured against this date. `windowStart` for the received figure is 2026-05-31. */
const AS_OF = '2026-06-30';

let scene: Scene;
let accounts: ReadonlyMap<string, SceneAccount>;
let sequence: bigint;

beforeEach(async () => {
  scene = await createScene(harness);
  accounts = await createChart(scene, [
    { code: BANK, type: 'asset', normalBalance: 'debit' },
    { code: RECEIVABLES, type: 'asset', normalBalance: 'debit' },
    { code: SALES, type: 'revenue', normalBalance: 'credit' },
  ]);
  sequence = 1n;
});

function accountId(code: string): string {
  const account = accounts.get(code);
  if (account === undefined) throw new Error(`The chart has no account ${code}.`);
  return account.id;
}

interface InvoiceInput {
  readonly contactId: string;
  readonly dueDate: string;
  readonly amount: bigint;
  readonly issueDate?: string;
}

/** An approved invoice: the journal first, then the document that points at it. */
async function approveInvoice(input: InvoiceInput): Promise<string> {
  const issueDate = input.issueDate ?? '2026-01-15';
  const journal = await post(scene, issueDate, [
    { accountId: accountId(RECEIVABLES), side: 'debit', amount: input.amount },
    { accountId: accountId(SALES), side: 'credit', amount: input.amount },
  ]);

  const id = newUuidBuffer();
  await harness.app
    .insertInto('ar_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: 'invoice',
      sequence_number: sequence++,
      contact_id: uuidToBuffer(input.contactId),
      issue_date: issueDate,
      due_date: input.dueDate,
      tax_mode: 'exclusive',
      reference: null,
      memo: null,
      journal_id: uuidToBuffer(journal.journalId),
      created_by_user_id: scene.userId,
    })
    .execute();

  await harness.app
    .insertInto('ar_document_lines')
    .values({
      org_id: scene.orgId,
      document_id: id,
      line_number: 1,
      description: 'One line, no tax.',
      quantity_micros: 1_000_000n,
      unit_amount_minor: input.amount,
      account_id: uuidToBuffer(accountId(SALES)),
      tax_rate_id: null,
      line_amount_minor: input.amount,
      tax_amount_minor: 0n,
    })
    .execute();

  return bufferToUuid(id);
}

/** A void is a reversing journal, never a deletion (D-16, D-38). */
async function voidInvoice(invoiceUuid: string, date: string, amount: bigint): Promise<void> {
  const reversal = await post(scene, date, [
    { accountId: accountId(SALES), side: 'debit', amount },
    { accountId: accountId(RECEIVABLES), side: 'credit', amount },
  ]);

  await harness.app
    .updateTable('ar_documents')
    .set({ void_journal_id: uuidToBuffer(reversal.journalId) })
    .where('id', '=', uuidToBuffer(invoiceUuid))
    .execute();
}

interface PaymentInput {
  readonly contactId: string;
  readonly date: string;
  readonly amount: bigint;
}

/** Money received, with no opinion about what it settles (D-37). */
async function recordReceived(input: PaymentInput): Promise<string> {
  const journal = await post(scene, input.date, [
    { accountId: accountId(BANK), side: 'debit', amount: input.amount },
    { accountId: accountId(RECEIVABLES), side: 'credit', amount: input.amount },
  ]);

  const id = newUuidBuffer();
  await harness.app
    .insertInto('payments')
    .values({
      id,
      org_id: scene.orgId,
      direction: 'received',
      sequence_number: sequence++,
      contact_id: uuidToBuffer(input.contactId),
      payment_date: input.date,
      amount_minor: input.amount,
      bank_account_id: uuidToBuffer(accountId(BANK)),
      reference: null,
      memo: null,
      journal_id: uuidToBuffer(journal.journalId),
      created_by_user_id: scene.userId,
    })
    .execute();

  return bufferToUuid(id);
}

/** An allocation posts no journal — it says which invoice a posted payment belongs to. */
async function allocateAr(input: {
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly amount: bigint;
  readonly date: string;
}): Promise<void> {
  await harness.app
    .insertInto('ar_allocations')
    .values({
      id: newUuidBuffer(),
      org_id: scene.orgId,
      invoice_id: uuidToBuffer(input.invoiceId),
      payment_id: uuidToBuffer(input.paymentId),
      credit_note_id: null,
      amount_minor: input.amount,
      allocated_on: input.date,
      created_by_user_id: scene.userId,
    })
    .execute();
}

describe('invoicesSummary', () => {
  it('sums outstanding across open invoices, excluding settled, voided and unbilled', async () => {
    const customer = await createParty(scene, 'Acme Retail');

    // Overdue and unpaid.
    await approveInvoice({ contactId: customer, dueDate: '2026-06-29', amount: 1000n });
    // Owed but not yet due.
    await approveInvoice({ contactId: customer, dueDate: '2026-07-15', amount: 500n });
    // Due exactly on `asOf` — owed, but not overdue (the aging report's `current` line).
    await approveInvoice({ contactId: customer, dueDate: AS_OF, amount: 400n });
    // Fully paid, so no longer an open item.
    const paidInvoice = await approveInvoice({
      contactId: customer,
      dueDate: '2026-05-01',
      amount: 800n,
    });
    const payment = await recordReceived({ contactId: customer, date: '2026-06-01', amount: 800n });
    await allocateAr({
      invoiceId: paidInvoice,
      paymentId: payment,
      amount: 800n,
      date: '2026-06-01',
    });
    // Voided, so reversed out of the ledger.
    const voided = await approveInvoice({
      contactId: customer,
      dueDate: '2026-06-01',
      amount: 300n,
    });
    await voidInvoice(voided, '2026-06-10', 300n);

    const summary = invoicesSummarySchema.parse(await invoicesSummary({ asOf: AS_OF }, scene.ctx));

    expect(summary.totalUnpaid).toBe('1900');
    expect(summary.openCount).toBe(3);
    // Only the 1000 invoice: the 500 is not due, the 400 is due today, and the paid and
    // voided ones carry nothing.
    expect(summary.totalOverdue).toBe('1000');
    expect(summary.overdueCount).toBe(1);
  });

  it('sums payments dated within the 30 days ending on asOf, on both boundaries', async () => {
    const customer = await createParty(scene, 'Acme Retail');

    await recordReceived({ contactId: customer, date: '2026-06-15', amount: 700n });
    await recordReceived({ contactId: customer, date: AS_OF, amount: 200n });
    // 2026-05-31 is exactly `asOf` minus 30 days — the inclusive start of the window.
    await recordReceived({ contactId: customer, date: '2026-05-31', amount: 100n });
    // One day earlier is outside it.
    await recordReceived({ contactId: customer, date: '2026-05-30', amount: 999n });

    const summary = await invoicesSummary({ asOf: AS_OF }, scene.ctx);

    expect(summary.paidLast30Days).toBe('1000');
  });

  it('is empty for an org with no invoices or payments', async () => {
    const summary = await invoicesSummary({ asOf: AS_OF }, scene.ctx);

    expect(summary).toEqual({
      asOf: AS_OF,
      totalUnpaid: '0',
      openCount: 0,
      totalOverdue: '0',
      overdueCount: 0,
      paidLast30Days: '0',
    });
  });

  it('defaults asOf to today when the caller gives no date', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const summary = await invoicesSummary({}, scene.ctx);

    expect(summary.asOf).toBe(today);
  });
});
