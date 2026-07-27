import type { PermissionKey } from '@openbooks/plugin-api';
import { agingSchema } from '@openbooks/shared-types';
import { beforeEach, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { systemDb } from '../../src/db';
import { NotFoundError, PermissionDeniedError, ValidationError } from '../../src/errors';
import { getAging } from '../../src/modules/reports/aging.service';
import { getAccountBalances } from '../../src/modules/reports/balances.service';
import { bufferToUuid, newUuid, newUuidBuffer, uuidToBuffer } from '../db';

import type { Scene, SceneAccount } from './support';
import {
  contextFor,
  createChart,
  createParty,
  createScene,
  post,
  useReportDatabase,
} from './support';

/**
 * Aging and the per-contact statement, worked by hand (OB-065; D-34, D-37, D-39,
 * D-40, acceptance C8).
 *
 * Two things are under test and only one of them is the buckets.
 *
 * The first is the arithmetic: which bucket a document falls in, that outstanding
 * is total minus allocations rather than a stored column, and that the five buckets
 * summed equal the control account's balance in the ledger. The last of those is
 * C8, and it is asserted here on ledgers small enough to add up in the margin;
 * OB-071 asserts the same identity as a property over generated ones.
 *
 * The second is **as-at**, which is the substance of the ticket. D-40 refuses the
 * failure D-32 accepted deliberately for sliced reports: aging as at a past date
 * must use the allocations that existed then, so the same request answers the same
 * way after a later payment lands. `reproduces a past date after a later allocation
 * lands` is that assertion, and it is the test the mutation in the report notes was
 * run against.
 *
 * ## Why the fixtures insert documents directly
 *
 * OB-062, OB-063 and OB-064 are being written alongside this ticket, so the AR, AP
 * and allocation services do not exist to build a fixture from. Every *journal*
 * below is nonetheless posted through `postJournal` — the ledger side of C8 has to
 * be the real one or the reconciliation proves nothing — and the document rows are
 * inserted as those services will insert them: a journal first, then the document
 * carrying its id and a sequence number, which is what `chk_ar_documents_approved`
 * requires of an approved document.
 */
const harness = useReportDatabase();

const BANK = '1000';
const RECEIVABLES = '1100';
const PAYABLES = '2000';
const SALES = '4000';
const COSTS = '5000';

/** Every bucket example is measured against this date. */
const AS_OF = '2026-06-30';

let scene: Scene;
let accounts: ReadonlyMap<string, SceneAccount>;
let sequence: bigint;

beforeEach(async () => {
  scene = await createScene(harness);
  accounts = await createChart(scene, [
    { code: BANK, type: 'asset', normalBalance: 'debit' },
    { code: RECEIVABLES, type: 'asset', normalBalance: 'debit' },
    { code: PAYABLES, type: 'liability', normalBalance: 'credit' },
    { code: SALES, type: 'revenue', normalBalance: 'credit' },
    { code: COSTS, type: 'expense', normalBalance: 'debit' },
  ]);
  sequence = 1n;
});

function accountId(code: string): string {
  const account = accounts.get(code);
  if (account === undefined) throw new Error(`The chart has no account ${code}.`);
  return account.id;
}

interface DocumentInput {
  readonly contactId: string;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly amount: bigint;
  readonly reference?: string;
}

/**
 * An approved invoice: the journal first, then the document that points at it.
 *
 * One line, at the full amount, with no tax — the tax columns are OB-066's and the
 * only thing aging reads from a line is `line_amount_minor + tax_amount_minor`.
 */
async function approveInvoice(input: DocumentInput): Promise<string> {
  const journal = await post(scene, input.issueDate, [
    { accountId: accountId(RECEIVABLES), side: 'debit', amount: input.amount },
    { accountId: accountId(SALES), side: 'credit', amount: input.amount },
  ]);

  return insertArDocument('invoice', journal.journalId, input);
}

/** A credit note: its own document and its own journal, never a negative invoice (D-39). */
async function approveCreditNote(input: DocumentInput): Promise<string> {
  const journal = await post(scene, input.issueDate, [
    { accountId: accountId(SALES), side: 'debit', amount: input.amount },
    { accountId: accountId(RECEIVABLES), side: 'credit', amount: input.amount },
  ]);

  return insertArDocument('credit_note', journal.journalId, input);
}

async function approveBill(input: DocumentInput): Promise<string> {
  const journal = await post(scene, input.issueDate, [
    { accountId: accountId(COSTS), side: 'debit', amount: input.amount },
    { accountId: accountId(PAYABLES), side: 'credit', amount: input.amount },
  ]);

  return insertApDocument('bill', journal.journalId, input);
}

async function approveVendorCredit(input: DocumentInput): Promise<string> {
  const journal = await post(scene, input.issueDate, [
    { accountId: accountId(PAYABLES), side: 'debit', amount: input.amount },
    { accountId: accountId(COSTS), side: 'credit', amount: input.amount },
  ]);

  return insertApDocument('vendor_credit', journal.journalId, input);
}

async function insertArDocument(
  documentType: 'invoice' | 'credit_note',
  journalUuid: string,
  input: DocumentInput,
): Promise<string> {
  const id = newUuidBuffer();

  await harness.app
    .insertInto('ar_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: documentType,
      sequence_number: sequence++,
      contact_id: uuidToBuffer(input.contactId),
      issue_date: input.issueDate,
      due_date: input.dueDate ?? null,
      tax_mode: 'exclusive',
      reference: input.reference ?? null,
      memo: null,
      journal_id: uuidToBuffer(journalUuid),
      created_by_user_id: scene.userId,
    })
    .execute();

  await insertLine('ar_document_lines', id, input.amount);
  return bufferToUuid(id);
}

async function insertApDocument(
  documentType: 'bill' | 'vendor_credit',
  journalUuid: string,
  input: DocumentInput,
): Promise<string> {
  const id = newUuidBuffer();

  await harness.app
    .insertInto('ap_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: documentType,
      sequence_number: sequence++,
      contact_id: uuidToBuffer(input.contactId),
      issue_date: input.issueDate,
      due_date: input.dueDate ?? null,
      tax_mode: 'exclusive',
      reference: input.reference ?? null,
      memo: null,
      journal_id: uuidToBuffer(journalUuid),
      created_by_user_id: scene.userId,
    })
    .execute();

  await insertLine('ap_document_lines', id, input.amount);
  return bufferToUuid(id);
}

async function insertLine(
  table: 'ar_document_lines' | 'ap_document_lines',
  documentId: Buffer,
  amount: bigint,
): Promise<void> {
  await harness.app
    .insertInto(table)
    .values({
      org_id: scene.orgId,
      document_id: documentId,
      line_number: 1,
      description: 'One line, no tax.',
      quantity_micros: 1_000_000n,
      unit_amount_minor: amount,
      account_id: uuidToBuffer(accountId(table === 'ar_document_lines' ? SALES : COSTS)),
      tax_rate_id: null,
      line_amount_minor: amount,
      tax_amount_minor: 0n,
    })
    .execute();
}

interface PaymentInput {
  readonly contactId: string;
  readonly date: string;
  readonly amount: bigint;
}

/** Money moving, with no opinion about what it settles (D-37). */
async function recordPayment(direction: 'received' | 'paid', input: PaymentInput): Promise<string> {
  const control = direction === 'received' ? RECEIVABLES : PAYABLES;
  const journal = await post(scene, input.date, [
    {
      accountId: accountId(direction === 'received' ? BANK : control),
      side: 'debit',
      amount: input.amount,
    },
    {
      accountId: accountId(direction === 'received' ? control : BANK),
      side: 'credit',
      amount: input.amount,
    },
  ]);

  const id = newUuidBuffer();
  await harness.app
    .insertInto('payments')
    .values({
      id,
      org_id: scene.orgId,
      direction,
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

interface AllocationInput {
  readonly targetId: string;
  readonly amount: bigint;
  readonly date: string;
  readonly paymentId?: string;
  readonly creditId?: string;
}

/** An allocation posts no journal — it says which document a posted credit belongs to. */
async function allocateAr(input: AllocationInput): Promise<void> {
  await harness.app
    .insertInto('ar_allocations')
    .values({
      id: newUuidBuffer(),
      org_id: scene.orgId,
      invoice_id: uuidToBuffer(input.targetId),
      payment_id: input.paymentId === undefined ? null : uuidToBuffer(input.paymentId),
      credit_note_id: input.creditId === undefined ? null : uuidToBuffer(input.creditId),
      amount_minor: input.amount,
      allocated_on: input.date,
      created_by_user_id: scene.userId,
    })
    .execute();
}

async function allocateAp(input: AllocationInput): Promise<void> {
  await harness.app
    .insertInto('ap_allocations')
    .values({
      id: newUuidBuffer(),
      org_id: scene.orgId,
      bill_id: uuidToBuffer(input.targetId),
      payment_id: input.paymentId === undefined ? null : uuidToBuffer(input.paymentId),
      vendor_credit_id: input.creditId === undefined ? null : uuidToBuffer(input.creditId),
      amount_minor: input.amount,
      allocated_on: input.date,
      created_by_user_id: scene.userId,
    })
    .execute();
}

/** Void is a reversing journal, never a deletion (D-16, D-38). */
async function voidInvoice(documentUuid: string, date: string, amount: bigint): Promise<void> {
  const reversal = await post(scene, date, [
    { accountId: accountId(SALES), side: 'debit', amount },
    { accountId: accountId(RECEIVABLES), side: 'credit', amount },
  ]);

  await harness.app
    .updateTable('ar_documents')
    .set({ void_journal_id: uuidToBuffer(reversal.journalId) })
    .where('id', '=', uuidToBuffer(documentUuid))
    .execute();
}

/**
 * The other side of C8, computed the way OB-071 should compute it: one call to the
 * report core for the control account's closing balance as at the date, and nothing
 * from the subledger at all.
 */
async function controlBalance(code: string, asOf: string): Promise<bigint> {
  const id = accountId(code);
  const balances = await getAccountBalances({ to: asOf }, scene.ctx, { accountIds: [id] });
  const row = balances.groups[0]?.rows.find((candidate) => candidate.accountId === id);
  if (row === undefined) throw new Error(`The report core returned no row for account ${code}.`);

  return row.balance.closing.balance;
}

async function customRole(orgUuid: string, permissions: readonly PermissionKey[]): Promise<string> {
  const roleUuid = newUuid();
  const roleId = uuidToBuffer(roleUuid);

  await systemDb()
    .insertInto('roles')
    .values({
      id: roleId,
      org_id: uuidToBuffer(orgUuid),
      code: `aging-role-${roleUuid.slice(0, 8)}`,
      name: 'Test role',
      description: 'Created by the OB-065 suite.',
      is_system: 0,
    })
    .execute();

  if (permissions.length > 0) {
    await systemDb()
      .insertInto('role_permissions')
      .values(permissions.map((code) => ({ role_id: roleId, permission_code: code })))
      .execute();
  }

  return roleUuid;
}

describe('buckets', () => {
  /**
   * One invoice per boundary, each for a distinct amount, so a document landing in
   * the wrong bucket is visible in the figure rather than only in a count.
   *
   * The boundaries are the ones `AGING_BUCKET_UPPER_BOUNDS` publishes, taken from
   * both sides: 30 and 31, 60 and 61, 90 and 91. A report that computed days from
   * the *issue* date instead of the due date would put every one of these in a
   * different bucket, which is D-40's whole point about what "overdue" means.
   */
  it('measures days past due from the due date, both sides of every boundary', async () => {
    const contactId = await createParty(scene, 'Boundary Co');

    const cases = [
      { dueDate: '2026-07-15', amount: 100n, bucket: 'current', days: -15 },
      { dueDate: '2026-06-30', amount: 200n, bucket: 'current', days: 0 },
      { dueDate: '2026-06-29', amount: 400n, bucket: 'days1To30', days: 1 },
      { dueDate: '2026-05-31', amount: 800n, bucket: 'days1To30', days: 30 },
      { dueDate: '2026-05-30', amount: 1600n, bucket: 'days31To60', days: 31 },
      { dueDate: '2026-05-01', amount: 3200n, bucket: 'days31To60', days: 60 },
      { dueDate: '2026-04-30', amount: 6400n, bucket: 'days61To90', days: 61 },
      { dueDate: '2026-04-01', amount: 12800n, bucket: 'days61To90', days: 90 },
      { dueDate: '2026-03-31', amount: 25600n, bucket: 'days90Plus', days: 91 },
    ] as const;

    for (const example of cases) {
      await approveInvoice({
        contactId,
        issueDate: '2026-03-01',
        dueDate: example.dueDate,
        amount: example.amount,
      });
    }

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);
    const row = aging.rows[0];

    expect(aging.rows).toHaveLength(1);
    expect(row?.amounts).toEqual({
      current: '300',
      days1To30: '1200',
      days31To60: '4800',
      days61To90: '19200',
      days90Plus: '25600',
      total: '51100',
    });

    for (const example of cases) {
      const document = row?.documents?.find(
        (candidate) => candidate.outstanding === example.amount.toString(),
      );
      expect(document?.bucket).toBe(example.bucket);
      expect(document?.daysPastDue).toBe(example.days);
    }
  });

  it('answers the published response schema', async () => {
    const contactId = await createParty(scene, 'Schema Co');
    await approveInvoice({
      contactId,
      issueDate: '2026-01-05',
      dueDate: '2026-02-04',
      amount: 150000n,
      reference: 'PO-9',
    });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);

    expect(() => agingSchema.parse(aging)).not.toThrow();
    expect(aging.rows[0]?.documents?.[0]).toMatchObject({
      documentType: 'invoice',
      documentNumber: '1',
      reference: 'PO-9',
      issueDate: '2026-01-05',
      dueDate: '2026-02-04',
      total: '150000',
      outstanding: '150000',
      bucket: 'days90Plus',
    });
  });

  it('omits the documents array entirely unless detail was asked for', async () => {
    const contactId = await createParty(scene, 'Summary Co');
    await approveInvoice({
      contactId,
      issueDate: '2026-01-05',
      dueDate: '2026-02-04',
      amount: 500n,
    });

    const summary = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    expect(summary.rows[0]?.documents).toBeNull();
  });
});

describe('outstanding is derived', () => {
  /**
   * D-34: an invoice does not carry what is outstanding on it. Three allocations of
   * different sizes against one invoice, and the figure that appears is the
   * subtraction — there is no column that could have been read instead.
   */
  it('is the total less the allocations, never a stored column', async () => {
    const contactId = await createParty(scene, 'Part Paid Co');
    const invoiceId = await approveInvoice({
      contactId,
      issueDate: '2026-05-01',
      dueDate: '2026-05-31',
      amount: 100000n,
    });

    const paymentId = await recordPayment('received', {
      contactId,
      date: '2026-06-01',
      amount: 30000n,
    });
    const creditId = await approveCreditNote({
      contactId,
      issueDate: '2026-06-02',
      amount: 20000n,
    });

    await allocateAr({ targetId: invoiceId, paymentId, amount: 30000n, date: '2026-06-01' });
    await allocateAr({ targetId: invoiceId, creditId, amount: 20000n, date: '2026-06-02' });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);

    expect(aging.rows[0]?.documents?.[0]?.outstanding).toBe('50000');
    expect(aging.totals.total).toBe('50000');
  });

  it('drops a settled contact unless includeZero is set, and never a settled document', async () => {
    const contactId = await createParty(scene, 'Settled Co');
    const invoiceId = await approveInvoice({
      contactId,
      issueDate: '2026-05-01',
      dueDate: '2026-05-31',
      amount: 4200n,
    });
    const paymentId = await recordPayment('received', {
      contactId,
      date: '2026-06-01',
      amount: 4200n,
    });
    await allocateAr({ targetId: invoiceId, paymentId, amount: 4200n, date: '2026-06-01' });

    const hidden = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);
    expect(hidden.rows).toHaveLength(0);
    expect(hidden.totals.total).toBe('0');

    const shown = await getAging(
      { asOf: AS_OF, ledger: 'receivable', detail: true, includeZero: true },
      scene.ctx,
    );
    expect(shown.rows).toHaveLength(1);
    expect(shown.rows[0]?.amounts.total).toBe('0');
    // A contact who has paid is still a contact; a paid invoice is not an open item.
    expect(shown.rows[0]?.documents).toEqual([]);
  });

  /**
   * A contact whose buckets cancel is kept even without `includeZero`, because
   * dropping it would change the report's per-bucket totals while leaving the grand
   * total right — C8 being false one column at a time.
   */
  it('keeps a contact whose buckets cancel to zero', async () => {
    const contactId = await createParty(scene, 'Cancelling Co');
    await approveInvoice({
      contactId,
      issueDate: '2026-01-05',
      dueDate: '2026-02-04',
      amount: 7000n,
    });
    await recordPayment('received', { contactId, date: '2026-06-01', amount: 7000n });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);

    expect(aging.rows).toHaveLength(1);
    expect(aging.totals).toMatchObject({
      current: '-7000',
      days90Plus: '7000',
      total: '0',
    });
  });
});

describe('unapplied credit', () => {
  /**
   * The half of the report that makes C8 true: a payment on account and an
   * unapplied credit note are already in the control account, so they are already
   * in the aging — as negatives in `current`, on the contact holding them (D-37).
   */
  it('carries a payment on account and an unapplied credit note as negative current', async () => {
    const contactId = await createParty(scene, 'On Account Co');
    await recordPayment('received', { contactId, date: '2026-06-10', amount: 25000n });
    await approveCreditNote({ contactId, issueDate: '2026-06-11', amount: 5000n });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);

    expect(aging.totals).toEqual({
      current: '-30000',
      days1To30: '0',
      days31To60: '0',
      days61To90: '0',
      days90Plus: '0',
      total: '-30000',
    });
    // OB-066a widened `AGING_DETAIL_TYPES` so the credit has a row of its own.
    // Before it, the detail array was empty here while `total` said -30000 — the
    // one place a contact's documents did not sum to its total.
    expect(aging.rows[0]?.documents).toEqual([
      {
        documentType: 'payment',
        documentId: expect.any(String),
        documentNumber: '1',
        reference: null,
        issueDate: '2026-06-10',
        dueDate: null,
        total: '-25000',
        outstanding: '-25000',
        daysPastDue: null,
        bucket: 'current',
      },
      {
        documentType: 'credit_note',
        documentId: expect.any(String),
        documentNumber: '2',
        reference: null,
        issueDate: '2026-06-11',
        dueDate: null,
        total: '-5000',
        outstanding: '-5000',
        daysPastDue: null,
        bucket: 'current',
      },
    ]);
  });

  /**
   * The property the widening exists for, and the one worth asserting over a
   * mixture rather than over a credit alone: on a contact holding both an overdue
   * invoice and a payment on account, the detail rows sum to the row's total.
   *
   * A sum rather than a shape, because a shape assertion passes against a report
   * that emits the right rows with the wrong signs — which is exactly the mistake
   * negating the amounts is there to avoid.
   */
  it('sums its detail rows to the row total, credits included', async () => {
    const contactId = await createParty(scene, 'Mixed Co');
    await approveInvoice({
      contactId,
      issueDate: '2026-01-05',
      dueDate: '2026-02-04',
      amount: 40000n,
    });
    await recordPayment('received', { contactId, date: '2026-06-10', amount: 15000n });
    await approveCreditNote({ contactId, issueDate: '2026-06-11', amount: 5000n });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);
    const row = aging.rows.find((candidate) => candidate.contactName === 'Mixed Co');

    expect(row?.documents).toHaveLength(3);
    const summed = (row?.documents ?? []).reduce(
      (total, document) => total + BigInt(document.outstanding),
      0n,
    );
    expect(summed.toString()).toBe(row?.amounts.total);
    expect(summed).toBe(20000n);
  });

  /**
   * Credits last, whatever their dates. The comparison sorts a null `dueDate`
   * after every date rather than before it, which is the opposite of what a string
   * comparison against an empty string would do — and a statement opening with two
   * unapplied receipts before the overdue invoice it is about is the wrong first
   * line.
   */
  it('sorts the credit rows after the dated ones', async () => {
    const contactId = await createParty(scene, 'Ordering Co');
    await recordPayment('received', { contactId, date: '2026-01-02', amount: 1000n });
    await approveInvoice({
      contactId,
      issueDate: '2026-05-05',
      dueDate: '2026-06-04',
      amount: 9000n,
    });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable', detail: true }, scene.ctx);
    const row = aging.rows.find((candidate) => candidate.contactName === 'Ordering Co');

    expect((row?.documents ?? []).map((document) => document.documentType)).toEqual([
      'invoice',
      'payment',
    ]);
  });
});

describe('as at', () => {
  /**
   * The ticket's headline property. The same request, over a database that has
   * changed only after the date it names, must produce the same bytes.
   *
   * Mutation-checked: reading the allocations regardless of `allocated_on` makes the
   * second call return 60000 where the first returned 100000.
   */
  it('reproduces a past date after a later allocation lands', async () => {
    const contactId = await createParty(scene, 'Reproducible Co');
    const invoiceId = await approveInvoice({
      contactId,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 100000n,
    });

    const before = await getAging(
      { asOf: '2026-02-28', ledger: 'receivable', detail: true },
      scene.ctx,
    );

    const paymentId = await recordPayment('received', {
      contactId,
      date: '2026-03-01',
      amount: 40000n,
    });
    await allocateAr({ targetId: invoiceId, paymentId, amount: 40000n, date: '2026-03-01' });

    const after = await getAging(
      { asOf: '2026-02-28', ledger: 'receivable', detail: true },
      scene.ctx,
    );

    expect(after).toEqual(before);
    expect(before.totals.total).toBe('100000');

    // And the later date sees the settlement, so the report did move — a report
    // that answered 100000 at every date would pass the equality above too.
    const later = await getAging(
      { asOf: '2026-03-31', ledger: 'receivable', detail: true },
      scene.ctx,
    );
    expect(later.totals.total).toBe('60000');
    expect(later.rows[0]?.documents?.[0]?.outstanding).toBe('60000');
  });

  /**
   * The case that separates "as at" from "ignore recent rows": a payment posted
   * before the date but applied after it. At the earlier date the money is in the
   * ledger and unapplied, so it is a credit; at the later date it is an allocation.
   * The total is the same at both, because both tie to the same control account —
   * which is exactly why the credit has to be in the report.
   */
  it('counts a payment posted before the date but allocated after it as credit', async () => {
    const contactId = await createParty(scene, 'Late Allocation Co');
    const invoiceId = await approveInvoice({
      contactId,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 100000n,
    });
    const paymentId = await recordPayment('received', {
      contactId,
      date: '2026-02-20',
      amount: 40000n,
    });
    await allocateAr({ targetId: invoiceId, paymentId, amount: 40000n, date: '2026-03-05' });

    const atFebruary = await getAging(
      { asOf: '2026-02-28', ledger: 'receivable', detail: true },
      scene.ctx,
    );
    expect(atFebruary.totals).toMatchObject({
      current: '-40000',
      days1To30: '100000',
      total: '60000',
    });
    expect(atFebruary.rows[0]?.documents?.[0]?.outstanding).toBe('100000');

    const atMarch = await getAging(
      { asOf: '2026-03-31', ledger: 'receivable', detail: true },
      scene.ctx,
    );
    expect(atMarch.totals).toMatchObject({ current: '0', total: '60000' });
    expect(atMarch.rows[0]?.documents?.[0]?.outstanding).toBe('60000');

    expect(await controlBalance(RECEIVABLES, '2026-02-28')).toBe(60000n);
    expect(await controlBalance(RECEIVABLES, '2026-03-31')).toBe(60000n);
  });

  /**
   * A document enters the report when its *journal* is in the ledger, not when its
   * `issue_date` says so. The two are the same for everything the AR service will
   * post; they are separable here, and the control account follows the journal.
   */
  it('admits a document on its journal date, not its issue date', async () => {
    const contactId = await createParty(scene, 'Backdated Co');
    const journal = await post(scene, '2026-07-05', [
      { accountId: accountId(RECEIVABLES), side: 'debit', amount: 900n },
      { accountId: accountId(SALES), side: 'credit', amount: 900n },
    ]);
    await insertArDocument('invoice', journal.journalId, {
      contactId,
      // Issued in June, told to the ledger in July.
      issueDate: '2026-06-01',
      dueDate: '2026-06-30',
      amount: 900n,
    });

    const atJune = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    expect(atJune.rows).toHaveLength(0);
    expect(await controlBalance(RECEIVABLES, AS_OF)).toBe(0n);

    const atJuly = await getAging({ asOf: '2026-07-31', ledger: 'receivable' }, scene.ctx);
    expect(atJuly.totals.total).toBe('900');
    expect(await controlBalance(RECEIVABLES, '2026-07-31')).toBe(900n);
  });

  it('keeps a document that is voided after the date and drops it once the reversal lands', async () => {
    const contactId = await createParty(scene, 'Voided Co');
    const invoiceId = await approveInvoice({
      contactId,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 3300n,
    });
    await voidInvoice(invoiceId, '2026-07-01', 3300n);

    const beforeVoid = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    expect(beforeVoid.totals.total).toBe('3300');
    expect(await controlBalance(RECEIVABLES, AS_OF)).toBe(3300n);

    const afterVoid = await getAging({ asOf: '2026-07-31', ledger: 'receivable' }, scene.ctx);
    expect(afterVoid.rows).toHaveLength(0);
    expect(await controlBalance(RECEIVABLES, '2026-07-31')).toBe(0n);
  });

  it('excludes a draft document, which has not happened', async () => {
    const contactId = await createParty(scene, 'Draft Co');
    await harness.app
      .insertInto('ar_documents')
      .values({
        id: newUuidBuffer(),
        org_id: scene.orgId,
        document_type: 'invoice',
        sequence_number: null,
        contact_id: uuidToBuffer(contactId),
        issue_date: '2026-01-10',
        due_date: '2026-02-09',
        tax_mode: 'exclusive',
        reference: null,
        memo: null,
        journal_id: null,
        created_by_user_id: scene.userId,
      })
      .execute();

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    expect(aging.rows).toHaveLength(0);
  });
});

describe('C8 — the buckets tie to the control account', () => {
  /**
   * The criterion, on a ledger with one of everything: two invoices, a credit note
   * partly applied, a payment partly applied, and an over-payment left on account.
   *
   * The right-hand side is computed the way OB-071 must compute it — the report
   * core's closing balance on the control account, reading `journal_lines` and
   * nothing from the subledger — so the two sides share no code below
   * `getAccountBalances`.
   */
  it('sums to the receivable control account at several dates', async () => {
    const alice = await createParty(scene, 'Alice');
    const bob = await createParty(scene, 'Bob');

    const first = await approveInvoice({
      contactId: alice,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 120000n,
    });
    const second = await approveInvoice({
      contactId: bob,
      issueDate: '2026-04-01',
      dueDate: '2026-05-01',
      amount: 80000n,
    });

    const creditId = await approveCreditNote({
      contactId: alice,
      issueDate: '2026-03-01',
      amount: 30000n,
    });
    await allocateAr({ targetId: first, creditId, amount: 20000n, date: '2026-03-02' });

    const payment = await recordPayment('received', {
      contactId: bob,
      date: '2026-05-15',
      amount: 95000n,
    });
    await allocateAr({ targetId: second, paymentId: payment, amount: 80000n, date: '2026-05-15' });

    for (const asOf of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', AS_OF]) {
      const aging = await getAging({ asOf, ledger: 'receivable' }, scene.ctx);
      expect(BigInt(aging.totals.total)).toBe(await controlBalance(RECEIVABLES, asOf));
    }
  });

  /**
   * The payable mirror. A payable is a credit-normal account, so the ledger side is
   * the control account's balance with its sign flipped — which is the one thing
   * OB-071 has to state differently for the two ledgers.
   */
  it('sums to the payable control account, sign flipped', async () => {
    const vendor = await createParty(scene, 'Vendor Co');

    const bill = await approveBill({
      contactId: vendor,
      issueDate: '2026-02-01',
      dueDate: '2026-03-03',
      amount: 60000n,
    });
    const creditId = await approveVendorCredit({
      contactId: vendor,
      issueDate: '2026-03-10',
      amount: 15000n,
    });
    await allocateAp({ targetId: bill, creditId, amount: 10000n, date: '2026-03-11' });

    const payment = await recordPayment('paid', {
      contactId: vendor,
      date: '2026-04-05',
      amount: 20000n,
    });
    await allocateAp({ targetId: bill, paymentId: payment, amount: 20000n, date: '2026-04-05' });

    for (const asOf of ['2026-02-28', '2026-03-31', '2026-04-30', AS_OF]) {
      const aging = await getAging({ asOf, ledger: 'payable' }, scene.ctx);
      expect(BigInt(aging.totals.total)).toBe(-(await controlBalance(PAYABLES, asOf)));
    }

    const aging = await getAging({ asOf: AS_OF, ledger: 'payable', detail: true }, scene.ctx);
    expect(aging.rows[0]?.documents?.[0]?.documentType).toBe('bill');
    expect(aging.rows[0]?.amounts).toMatchObject({
      current: '-5000',
      days90Plus: '30000',
      total: '25000',
    });
  });

  it('sums its rows, bucket by bucket, to its own totals', async () => {
    const alice = await createParty(scene, 'Alice');
    const bob = await createParty(scene, 'Bob');

    await approveInvoice({
      contactId: alice,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 1100n,
    });
    await approveInvoice({
      contactId: bob,
      issueDate: '2026-06-01',
      dueDate: '2026-06-20',
      amount: 2200n,
    });
    await recordPayment('received', { contactId: bob, date: '2026-06-25', amount: 300n });

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    const buckets = ['current', 'days1To30', 'days31To60', 'days61To90', 'days90Plus'] as const;

    for (const bucket of buckets) {
      const summed = aging.rows.reduce((total, row) => total + BigInt(row.amounts[bucket]), 0n);
      expect(summed).toBe(BigInt(aging.totals[bucket]));
    }

    const total = buckets.reduce((sum, bucket) => sum + BigInt(aging.totals[bucket]), 0n);
    expect(total).toBe(BigInt(aging.totals.total));
  });

  /**
   * The two ledgers do not see each other's documents. A bill in the receivable
   * report would tie to nothing, and it is the failure a shared documents table
   * would have made a single forgotten predicate away (`0005_subledger`).
   */
  it('keeps the two ledgers apart', async () => {
    const contactId = await createParty(scene, 'Both Sides Co');
    await approveInvoice({
      contactId,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 500n,
    });
    await approveBill({
      contactId,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 900n,
    });

    expect((await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx)).totals.total).toBe(
      '500',
    );
    expect((await getAging({ asOf: AS_OF, ledger: 'payable' }, scene.ctx)).totals.total).toBe(
      '900',
    );
  });
});

describe('the statement', () => {
  /**
   * "What does this customer owe, and since when" is this report with `contactId`
   * and `detail`, not a second endpoint — a second one would be a second definition
   * of outstanding (D-34).
   */
  it('narrows to one contact and lists their open documents oldest first', async () => {
    const alice = await createParty(scene, 'Alice');
    const bob = await createParty(scene, 'Bob');

    await approveInvoice({
      contactId: alice,
      issueDate: '2026-05-01',
      dueDate: '2026-06-15',
      amount: 300n,
    });
    await approveInvoice({
      contactId: alice,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 700n,
      reference: 'PO-1',
    });
    await approveInvoice({
      contactId: bob,
      issueDate: '2026-01-10',
      dueDate: '2026-02-09',
      amount: 999n,
    });

    const statement = await getAging(
      { asOf: AS_OF, ledger: 'receivable', contactId: alice, detail: true },
      scene.ctx,
    );

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]?.contactName).toBe('Alice');
    expect(statement.rows[0]?.documents?.map((document) => document.dueDate)).toEqual([
      '2026-02-09',
      '2026-06-15',
    ]);
    expect(statement.totals.total).toBe('1000');
  });

  it('orders rows by contact name', async () => {
    const zoe = await createParty(scene, 'Zoe');
    const alice = await createParty(scene, 'Alice');

    for (const contactId of [zoe, alice]) {
      await approveInvoice({
        contactId,
        issueDate: '2026-01-10',
        dueDate: '2026-02-09',
        amount: 100n,
      });
    }

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    expect(aging.rows.map((row) => row.contactName)).toEqual(['Alice', 'Zoe']);
  });
});

describe('boundaries', () => {
  it('is a 404 for a contact this org does not own, and for a malformed id', async () => {
    const other = await createScene(harness);
    const theirs = await createParty(other, 'Theirs');

    await expect(
      getAging({ asOf: AS_OF, ledger: 'receivable', contactId: theirs }, scene.ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports nothing about another org', async () => {
    const other = await createScene(harness);
    const otherAccounts = await createChart(other, [
      { code: RECEIVABLES, type: 'asset', normalBalance: 'debit' },
      { code: SALES, type: 'revenue', normalBalance: 'credit' },
    ]);
    const theirContact = await createParty(other, 'Theirs');
    const theirReceivables = otherAccounts.get(RECEIVABLES)?.id ?? '';
    const theirSales = otherAccounts.get(SALES)?.id ?? '';

    const journal = await post(other, '2026-01-10', [
      { accountId: theirReceivables, side: 'debit', amount: 5000n },
      { accountId: theirSales, side: 'credit', amount: 5000n },
    ]);
    await harness.app
      .insertInto('ar_documents')
      .values({
        id: newUuidBuffer(),
        org_id: other.orgId,
        document_type: 'invoice',
        sequence_number: 1n,
        contact_id: uuidToBuffer(theirContact),
        issue_date: '2026-01-10',
        due_date: '2026-02-09',
        tax_mode: 'exclusive',
        reference: null,
        memo: null,
        journal_id: uuidToBuffer(journal.journalId),
        created_by_user_id: other.userId,
      })
      .execute();

    const aging = await getAging({ asOf: AS_OF, ledger: 'receivable' }, scene.ctx);
    expect(aging.rows).toHaveLength(0);
  });

  it('requires reports.read', async () => {
    const roleUuid = await customRole(scene.orgUuid, ['invoices.read']);
    const ctx: RequestContext = contextFor(scene.orgUuid, roleUuid, bufferToUuid(scene.userId));

    const error = await runInContext(ctx, () =>
      getAging({ asOf: AS_OF, ledger: 'receivable' }, ctx).then(
        () => undefined,
        (thrown: unknown) => thrown,
      ),
    );

    expect(error).toBeInstanceOf(PermissionDeniedError);
    expect((error as PermissionDeniedError).details).toEqual({ permission: 'reports.read' });
  });

  it('refuses a query with no asOf, because a default would answer differently tomorrow', async () => {
    const missing = { ledger: 'receivable' } as unknown as Parameters<typeof getAging>[0];

    await expect(getAging(missing, scene.ctx)).rejects.toBeInstanceOf(ValidationError);
  });
});
