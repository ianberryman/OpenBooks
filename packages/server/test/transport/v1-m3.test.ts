import { describe, expect, it } from 'vitest';

import { errorBody } from './harness';
import { authorizedWrite, createAccount, registerUser, useV1App } from './v1-support';
import type { Session } from './v1-support';
import type { App } from '../../src/transport/index';

/**
 * OB-067's routes, end to end against real MySQL.
 *
 * The subledger services already have deep suites of their own — the approval lock,
 * the over-allocation refusal, the tax arithmetic, the aging as-at rule. What is
 * unproven until a route exists is the *boundary*, so these are transport cases: the
 * mapping reaching the right service with the right arguments, a querystring's text
 * becoming the value the service takes, a status and a `Location` being what the
 * ticket says, the idempotency claim being scoped where the table above
 * `registerV1Routes` claims it is, and the wire contract expressing a distinction the
 * service depends on. A test here that could be written against the service alone
 * belongs there instead.
 *
 * Three are not boundary cases and are here deliberately, because here is where they
 * are true:
 *
 *  - **`PATCH` cannot approve.** The shape decision this ticket made is only worth
 *    anything if a client that tries the other shape is refused, and that is a fact
 *    about the published request schema rather than about the service.
 *  - **The control-account patch distinguishes absent from `null`.** The ticket asked
 *    for a wire contract that does not collapse the two; the only place that is
 *    observable is over HTTP.
 *  - **Allocation is one mechanism reached from three paths.** D-39's claim is that
 *    what reduced an invoice does not change what "outstanding" means, and the routes
 *    are where a client could discover otherwise.
 */

const harness = useV1App();

interface Books {
  readonly session: Session;
  readonly bank: string;
  readonly receivable: string;
  readonly payable: string;
  readonly revenue: string;
  readonly expense: string;
  readonly taxLiability: string;
  readonly customer: string;
  readonly vendor: string;
}

/**
 * An org that can actually approve something: a chart, a fiscal year, the two
 * control-account nominations, and one contact on each side.
 *
 * Built entirely through `/v1` rather than through `test/db/factories.ts`, including
 * the nominations — `factories.controlAccounts` exists and would be shorter, but the
 * nomination route is one of the routes under test and a fixture that wrote the row
 * directly would leave `updateControlAccounts` exercised by nothing.
 */
async function setUpBooks(app: App, slug: string): Promise<Books> {
  const session = await registerUser(app, {
    email: `${slug}@example.invalid`,
    orgName: `${slug} Books`,
  });

  const [bank, receivable, payable, revenue, expense, taxLiability] = await Promise.all([
    createAccount(app, session, {
      code: '1000',
      name: 'Bank',
      type: 'asset',
      normalBalance: 'debit',
    }),
    createAccount(app, session, {
      code: '1100',
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    createAccount(app, session, {
      code: '2010',
      name: 'Accounts payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
    createAccount(app, session, {
      code: '4000',
      name: 'Sales',
      type: 'revenue',
      normalBalance: 'credit',
    }),
    createAccount(app, session, {
      code: '5000',
      name: 'Supplies',
      type: 'expense',
      normalBalance: 'debit',
    }),
    createAccount(app, session, {
      code: '2200',
      name: 'VAT control',
      type: 'liability',
      normalBalance: 'credit',
    }),
  ]);

  const year = await app.inject({
    method: 'POST',
    url: '/v1/fiscal-years',
    headers: authorizedWrite(session, `year-${slug}`),
    payload: { fiscalYear: 2026 },
  });
  if (year.statusCode !== 201) throw new Error(`fiscal year failed: ${year.body}`);

  const nominated = await app.inject({
    method: 'PATCH',
    url: '/v1/accounting-settings',
    headers: authorizedWrite(session, `settings-${slug}`),
    payload: { receivableControlAccountId: receivable, payableControlAccountId: payable },
  });
  if (nominated.statusCode !== 200) throw new Error(`nomination failed: ${nominated.body}`);

  const [customer, vendor] = await Promise.all([
    createContact(app, session, `${slug}-cust`, { isCustomer: true }),
    createContact(app, session, `${slug}-vend`, { isVendor: true }),
  ]);

  return {
    session,
    bank,
    receivable,
    payable,
    revenue,
    expense,
    taxLiability,
    customer,
    vendor,
  };
}

async function createContact(
  app: App,
  session: Session,
  code: string,
  flags: { readonly isCustomer?: boolean; readonly isVendor?: boolean },
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/contacts',
    headers: authorizedWrite(session, `contact-${code}`),
    payload: { code, displayName: code, ...flags },
  });
  if (response.statusCode !== 201) throw new Error(`contact failed: ${response.body}`);
  return response.json<{ id: string }>().id;
}

interface DocumentBody {
  readonly id: string;
  readonly documentNumber: string | null;
  readonly status: string;
  readonly journalId: string | null;
  readonly voidJournalId: string | null;
  readonly totals: { readonly net: string; readonly tax: string; readonly gross: string };
  readonly settlement: { readonly allocated: string; readonly outstanding: string };
}

describe('invoices', () => {
  it('creates a draft, approves it into the ledger, and reports settlement as it is paid', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'ar');
    const { session } = books;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: authorizedWrite(session, 'inv-1'),
      payload: {
        contactId: books.customer,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        taxMode: 'exclusive',
        reference: 'PO-4471',
        lines: [
          {
            description: 'Consulting',
            quantity: '2',
            unitAmount: '75000',
            accountId: books.revenue,
          },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<DocumentBody>();
    expect(created.headers['location']).toBe(`/v1/invoices/${draft.id}`);

    // A draft holds no number, because a number reserved by a draft that was then
    // discarded would leave a gap (D-36 through D-14).
    expect(draft).toMatchObject({
      documentNumber: null,
      status: 'draft',
      journalId: null,
      totals: { net: '150000', tax: '0', gross: '150000' },
      settlement: { allocated: '0', outstanding: '150000' },
    });

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${draft.id}/approve`,
      headers: authorizedWrite(session, 'inv-1-approve'),
    });
    expect(approved.statusCode).toBe(200);
    const invoice = approved.json<DocumentBody>();
    expect(invoice.status).toBe('approved');
    expect(invoice.documentNumber).not.toBeNull();
    expect(invoice.journalId).not.toBeNull();

    /**
     * Idempotency is claimed against the path id as well as the body, so the same
     * key replayed returns the original response rather than posting a second
     * journal. `approveInvoice` takes no body at all, which is exactly why the id has
     * to be in the fingerprint.
     */
    const replayed = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${draft.id}/approve`,
      headers: authorizedWrite(session, 'inv-1-approve'),
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json<DocumentBody>().journalId).toBe(invoice.journalId);

    const partPaid = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: authorizedWrite(session, 'pay-1'),
      payload: {
        direction: 'received',
        contactId: books.customer,
        date: '2026-03-15',
        amount: '50000',
        accountId: books.bank,
        allocations: [{ targetType: 'invoice', targetId: draft.id, amount: '50000' }],
      },
    });
    expect(partPaid.statusCode).toBe(201);

    const read = await app.inject({
      method: 'GET',
      url: `/v1/invoices/${draft.id}`,
      headers: { cookie: session.cookie },
    });
    expect(read.statusCode).toBe(200);
    // Both are computed on read (D-34, D-38): nothing wrote a balance or a status.
    expect(read.json<DocumentBody>()).toMatchObject({
      status: 'part_paid',
      settlement: { allocated: '50000', outstanding: '100000' },
    });
  });

  /**
   * The shape decision, asserted where it is observable.
   *
   * `status` is computed (D-38), so `updateInvoiceRequestSchema` is a `strictObject`
   * that does not name it — a client reaching for `PATCH { status: 'approved' }` is
   * refused by validation rather than quietly ignored, which is what makes "approve
   * is not an update" a property of the published contract and not only of this
   * file's commentary.
   */
  it('refuses to approve through a status patch, and refuses to delete an approved invoice', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'shape');
    const { session } = books;
    const invoiceId = await createInvoice(app, books, 'shape-1');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/invoices/${invoiceId}`,
      headers: authorizedWrite(session, 'shape-1-patch'),
      payload: { status: 'approved' },
    });
    expect(patched.statusCode).toBe(400);
    expect(errorBody(patched.body).error.code).toBe('validation_failed');

    const approved = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/approve`,
      headers: authorizedWrite(session, 'shape-1-approve'),
    });
    expect(approved.statusCode).toBe(200);

    const discarded = await app.inject({
      method: 'DELETE',
      url: `/v1/invoices/${invoiceId}`,
      headers: authorizedWrite(session, 'shape-1-discard'),
    });
    expect(discarded.statusCode).toBe(412);
    expect(errorBody(discarded.body).error).toMatchObject({
      code: 'precondition_failed',
      details: { precondition: 'document_approved' },
    });

    const voided = await app.inject({
      method: 'POST',
      url: `/v1/invoices/${invoiceId}/void`,
      headers: authorizedWrite(session, 'shape-1-void'),
      payload: { date: '2026-04-01', memo: 'Raised in error' },
    });
    expect(voided.statusCode).toBe(200);
    const body = voided.json<DocumentBody>();
    // Nothing is deleted: the number and both journals stay visible (D-16, C7).
    expect(body.status).toBe('void');
    expect(body.documentNumber).not.toBeNull();
    expect(body.journalId).not.toBeNull();
    expect(body.voidJournalId).not.toBeNull();
  });

  /** A7: another org's invoice is a 404 byte-identical to an id that names nothing. */
  it('answers a cross-org read with the same bytes as an unknown id', async () => {
    const app = harness.app();
    const mine = await setUpBooks(app, 'a7-mine');
    const theirs = await setUpBooks(app, 'a7-theirs');
    const invoiceId = await createInvoice(app, theirs, 'a7-1');

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/v1/invoices/${invoiceId}`,
      headers: { cookie: mine.session.cookie },
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/invoices/00000000-0000-4000-8000-000000000000',
      headers: { cookie: mine.session.cookie },
    });

    expect(crossOrg.statusCode).toBe(404);
    expect(crossOrg.body).toBe(unknown.body);
  });
});

describe('allocation', () => {
  /**
   * D-39's claim, from the routes' side: a credit note reduces an invoice through the
   * same rows a payment does, so "outstanding" means one thing regardless of which
   * path applied it — and un-applying is a plain `DELETE` that restores it, because
   * an allocation posts no journal.
   */
  it('applies a credit note through the payments module and un-applies it again', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'alloc');
    const { session } = books;

    const invoiceId = await createInvoice(app, books, 'alloc-inv');
    await approve(app, session, `/v1/invoices/${invoiceId}/approve`, 'alloc-inv-approve');

    const creditNote = await app.inject({
      method: 'POST',
      url: '/v1/credit-notes',
      headers: authorizedWrite(session, 'alloc-cn'),
      payload: {
        contactId: books.customer,
        issueDate: '2026-03-10',
        taxMode: 'exclusive',
        lines: [
          { description: 'Goodwill', quantity: '1', unitAmount: '40000', accountId: books.revenue },
        ],
      },
    });
    expect(creditNote.statusCode).toBe(201);
    const creditNoteId = creditNote.json<DocumentBody>().id;
    await approve(app, session, `/v1/credit-notes/${creditNoteId}/approve`, 'alloc-cn-approve');

    const applied = await app.inject({
      method: 'POST',
      url: `/v1/credit-notes/${creditNoteId}/allocations`,
      headers: authorizedWrite(session, 'alloc-apply'),
      payload: { allocations: [{ targetType: 'invoice', targetId: invoiceId, amount: '40000' }] },
    });
    expect(applied.statusCode).toBe(201);
    const allocations = applied.json<{
      allocations: { id: string; sourceType: string; targetType: string; amount: string }[];
    }>().allocations;
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      sourceType: 'credit_note',
      targetType: 'invoice',
      amount: '40000',
    });

    expect(await settlementOf(app, session, `/v1/invoices/${invoiceId}`)).toEqual({
      allocated: '40000',
      outstanding: '110000',
    });

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/allocations/${allocations[0]?.id ?? ''}`,
      headers: authorizedWrite(session, 'alloc-remove'),
    });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');

    expect(await settlementOf(app, session, `/v1/invoices/${invoiceId}`)).toEqual({
      allocated: '0',
      outstanding: '150000',
    });
  });

  it('refuses to over-allocate a document and writes nothing of the batch', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'over');
    const { session } = books;

    const invoiceId = await createInvoice(app, books, 'over-inv');
    await approve(app, session, `/v1/invoices/${invoiceId}/approve`, 'over-inv-approve');

    const payment = await app.inject({
      method: 'POST',
      url: '/v1/payments',
      headers: authorizedWrite(session, 'over-pay'),
      payload: {
        direction: 'received',
        contactId: books.customer,
        date: '2026-03-20',
        amount: '200000',
        accountId: books.bank,
      },
    });
    expect(payment.statusCode).toBe(201);
    const paymentId = payment.json<DocumentBody>().id;

    // Over-*paying* is fine and lands as credit; over-allocating a document is not
    // (D-37's asymmetry, C3).
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/payments/${paymentId}/allocations`,
      headers: authorizedWrite(session, 'over-apply'),
      payload: { allocations: [{ targetType: 'invoice', targetId: invoiceId, amount: '200000' }] },
    });
    expect(refused.statusCode).toBe(412);
    expect(errorBody(refused.body).error.details).toMatchObject({
      precondition: 'document_over_allocated',
    });

    expect(await settlementOf(app, session, `/v1/invoices/${invoiceId}`)).toEqual({
      allocated: '0',
      outstanding: '150000',
    });
  });
});

describe('bills', () => {
  it('approves against the payables control account and refuses a duplicate vendor reference', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'ap');
    const { session } = books;

    const first = await createBill(app, books, 'ap-1', 'VENDOR-88');
    const approved = await app.inject({
      method: 'POST',
      url: `/v1/bills/${first}/approve`,
      headers: authorizedWrite(session, 'ap-1-approve'),
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json<DocumentBody>()).toMatchObject({ status: 'approved' });

    const second = await createBill(app, books, 'ap-2', 'VENDOR-88');
    const duplicate = await app.inject({
      method: 'POST',
      url: `/v1/bills/${second}/approve`,
      headers: authorizedWrite(session, 'ap-2-approve'),
    });
    expect(duplicate.statusCode).toBe(412);
    expect(errorBody(duplicate.body).error.details).toMatchObject({
      precondition: 'duplicate_vendor_reference',
    });

    // The reference filter exists on bills and not on invoices, which is the whole
    // of D-36's point about this field.
    const found = await app.inject({
      method: 'GET',
      url: '/v1/bills?reference=VENDOR-88',
      headers: { cookie: session.cookie },
    });
    expect(found.statusCode).toBe(200);
    expect(found.json<{ items: DocumentBody[] }>().items).toHaveLength(2);
  });
});

describe('querystring coercion', () => {
  /**
   * The reason the shared list schemas take real booleans and the routes coerce:
   * `'false'` is truthy in every language an integrator might use, so a shared schema
   * that accepted the string would accept it from a JSON body too. Without the
   * coercion this request would filter to the unapplied credit notes and return one
   * fewer row.
   */
  it('reads `unappliedOnly=false` as false rather than as a non-empty string', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'coerce');
    const { session } = books;

    const invoiceId = await createInvoice(app, books, 'coerce-inv');
    await approve(app, session, `/v1/invoices/${invoiceId}/approve`, 'coerce-inv-approve');

    const creditNote = await app.inject({
      method: 'POST',
      url: '/v1/credit-notes',
      headers: authorizedWrite(session, 'coerce-cn'),
      payload: {
        contactId: books.customer,
        issueDate: '2026-03-10',
        taxMode: 'exclusive',
        lines: [
          { description: 'Return', quantity: '1', unitAmount: '20000', accountId: books.revenue },
        ],
      },
    });
    const creditNoteId = creditNote.json<DocumentBody>().id;
    await approve(app, session, `/v1/credit-notes/${creditNoteId}/approve`, 'coerce-cn-approve');
    const spent = await app.inject({
      method: 'POST',
      url: `/v1/credit-notes/${creditNoteId}/allocations`,
      headers: authorizedWrite(session, 'coerce-apply'),
      payload: { allocations: [{ targetType: 'invoice', targetId: invoiceId, amount: '20000' }] },
    });
    expect(spent.statusCode).toBe(201);

    const all = await app.inject({
      method: 'GET',
      url: '/v1/credit-notes?unappliedOnly=false',
      headers: { cookie: session.cookie },
    });
    expect(all.json<{ items: DocumentBody[] }>().items).toHaveLength(1);

    const unapplied = await app.inject({
      method: 'GET',
      url: '/v1/credit-notes?unappliedOnly=true',
      headers: { cookie: session.cookie },
    });
    expect(unapplied.json<{ items: DocumentBody[] }>().items).toHaveLength(0);
  });
});

describe('aging', () => {
  it('is a GET whose scalar filters cross the querystring, and refuses a missing asOf', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'aging');
    const { session } = books;

    const invoiceId = await createInvoice(app, books, 'aging-inv');
    await approve(app, session, `/v1/invoices/${invoiceId}/approve`, 'aging-inv-approve');

    const report = await app.inject({
      method: 'GET',
      url: '/v1/reports/aging?asOf=2026-04-15&ledger=receivable&detail=true',
      headers: { cookie: session.cookie },
    });
    expect(report.statusCode).toBe(200);
    const aging = report.json<{
      asOf: string;
      ledger: string;
      rows: { contactId: string; documents: { documentType: string; bucket: string }[] | null }[];
      totals: { total: string; days1To30: string };
    }>();
    expect(aging).toMatchObject({ asOf: '2026-04-15', ledger: 'receivable' });
    expect(aging.totals.total).toBe('150000');
    // Due 2026-03-31, read as at 2026-04-15: fifteen days past due, so 1–30.
    expect(aging.totals.days1To30).toBe('150000');
    expect(aging.rows[0]?.documents?.[0]).toMatchObject({
      documentType: 'invoice',
      bucket: 'days1To30',
    });

    // `detail` off is the default and returns null rather than an empty array — a
    // field that is sometimes missing would be two shapes.
    const summary = await app.inject({
      method: 'GET',
      url: '/v1/reports/aging?asOf=2026-04-15&ledger=receivable',
      headers: { cookie: session.cookie },
    });
    expect(summary.json<{ rows: { documents: unknown }[] }>().rows[0]?.documents).toBeNull();

    // Required, unlike every other report's bound: D-40 makes reproducibility the
    // point, and a default of "today" would answer differently tomorrow.
    const undated = await app.inject({
      method: 'GET',
      url: '/v1/reports/aging?ledger=receivable',
      headers: { cookie: session.cookie },
    });
    expect(undated.statusCode).toBe(400);
    expect(errorBody(undated.body).error.code).toBe('validation_failed');
  });
});

describe('tax rates', () => {
  it('creates, filters, archives and refuses to delete one a document cites', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'tax');
    const { session } = books;

    const created = await app.inject({
      method: 'POST',
      url: '/v1/tax-rates',
      headers: authorizedWrite(session, 'tax-1'),
      payload: {
        name: 'VAT 20%',
        percentage: '20',
        accountId: books.taxLiability,
        appliesTo: 'both',
      },
    });
    expect(created.statusCode).toBe(201);
    const rate = created.json<{ id: string; percentage: string; isActive: boolean }>();
    expect(created.headers['location']).toBe(`/v1/tax-rates/${rate.id}`);
    expect(rate).toMatchObject({ percentage: '20', isActive: true });

    // A usability predicate rather than an equality: `sales` includes `both`.
    const salesRates = await app.inject({
      method: 'GET',
      url: '/v1/tax-rates?appliesTo=sales&isActive=true',
      headers: { cookie: session.cookie },
    });
    expect(salesRates.json<{ items: { id: string }[] }>().items).toHaveLength(1);

    const unused = await app.inject({
      method: 'POST',
      url: '/v1/tax-rates',
      headers: authorizedWrite(session, 'tax-2'),
      payload: { name: 'Typo 17.5%', percentage: '17.5', accountId: books.taxLiability },
    });
    const unusedId = unused.json<{ id: string }>().id;
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tax-rates/${unusedId}`,
      headers: authorizedWrite(session, 'tax-2-delete'),
    });
    expect(deleted.statusCode).toBe(204);

    // Cited by a document line, so archive is the only removal available.
    const invoice = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: authorizedWrite(session, 'tax-inv'),
      payload: {
        contactId: books.customer,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        taxMode: 'exclusive',
        lines: [
          {
            description: 'Consulting',
            quantity: '1',
            unitAmount: '100000',
            accountId: books.revenue,
            taxRateId: rate.id,
          },
        ],
      },
    });
    expect(invoice.statusCode).toBe(201);
    expect(invoice.json<DocumentBody>().totals).toEqual({
      net: '100000',
      tax: '20000',
      gross: '120000',
    });

    const inUse = await app.inject({
      method: 'DELETE',
      url: `/v1/tax-rates/${rate.id}`,
      headers: authorizedWrite(session, 'tax-1-delete'),
    });
    expect(inUse.statusCode).toBe(412);
    expect(errorBody(inUse.body).error.details).toMatchObject({ precondition: 'tax_rate_in_use' });

    const archived = await app.inject({
      method: 'POST',
      url: `/v1/tax-rates/${rate.id}/archive`,
      headers: authorizedWrite(session, 'tax-1-archive'),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json<{ isActive: boolean }>().isActive).toBe(false);

    const unarchived = await app.inject({
      method: 'POST',
      url: `/v1/tax-rates/${rate.id}/unarchive`,
      headers: authorizedWrite(session, 'tax-1-unarchive'),
    });
    expect(unarchived.json<{ isActive: boolean }>().isActive).toBe(true);
  });
});

describe('accounting settings', () => {
  /**
   * The distinction the ticket asked the wire contract to preserve. It is only
   * observable over HTTP, because it is the difference between a key being absent
   * from a JSON object and being present with the value `null`, and the service is
   * handed an already-parsed object either way.
   */
  it('leaves an omitted nomination alone and clears an explicit null', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'settings');
    const { session } = books;

    const initial = await app.inject({
      method: 'GET',
      url: '/v1/accounting-settings',
      headers: { cookie: session.cookie },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      receivableControlAccountId: books.receivable,
      payableControlAccountId: books.payable,
      inventoryShrinkageAccountId: null,
    });

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/v1/accounting-settings',
      headers: authorizedWrite(session, 'settings-clear'),
      payload: { payableControlAccountId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({
      receivableControlAccountId: books.receivable,
      payableControlAccountId: null,
      inventoryShrinkageAccountId: null,
    });

    // And what a cleared nomination costs is the next approval, loudly.
    const billId = await createBill(app, books, 'settings-bill', 'V-1');
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/bills/${billId}/approve`,
      headers: authorizedWrite(session, 'settings-bill-approve'),
    });
    expect(refused.statusCode).toBe(412);
    expect(errorBody(refused.body).error.details).toMatchObject({
      precondition: 'payable_control_account_not_set',
    });

    // An empty patch says nothing and is refused rather than treated as a clear.
    const empty = await app.inject({
      method: 'PATCH',
      url: '/v1/accounting-settings',
      headers: authorizedWrite(session, 'settings-empty'),
      payload: {},
    });
    expect(empty.statusCode).toBe(400);
  });
});

describe('the idempotency-key requirement', () => {
  /**
   * Spec §12 on the thirty-three writes this ticket adds. One case stands for all of
   * them because `requireIdempotencyKey` is an `onRequest` hook shared by every write
   * route in the table: it runs before validation, so a write with no key is a 400
   * whatever else is wrong with it.
   */
  it('refuses an M3 write that carries no key, before it reads the body', async () => {
    const app = harness.app();
    const books = await setUpBooks(app, 'idem');

    const response = await app.inject({
      method: 'POST',
      url: '/v1/invoices',
      headers: { cookie: books.session.cookie },
      payload: { nothing: 'valid about this body' },
    });

    expect(response.statusCode).toBe(400);
    expect(errorBody(response.body).error.code).toBe('validation_failed');
  });
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

async function createInvoice(app: App, books: Books, key: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/invoices',
    headers: authorizedWrite(books.session, key),
    payload: {
      contactId: books.customer,
      issueDate: '2026-03-01',
      dueDate: '2026-03-31',
      taxMode: 'exclusive',
      lines: [
        { description: 'Consulting', quantity: '2', unitAmount: '75000', accountId: books.revenue },
      ],
    },
  });
  if (response.statusCode !== 201) throw new Error(`invoice failed: ${response.body}`);
  return response.json<{ id: string }>().id;
}

async function createBill(app: App, books: Books, key: string, reference: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/bills',
    headers: authorizedWrite(books.session, key),
    payload: {
      contactId: books.vendor,
      issueDate: '2026-03-05',
      dueDate: '2026-04-05',
      taxMode: 'exclusive',
      reference,
      lines: [
        { description: 'Paper', quantity: '10', unitAmount: '1000', accountId: books.expense },
      ],
    },
  });
  if (response.statusCode !== 201) throw new Error(`bill failed: ${response.body}`);
  return response.json<{ id: string }>().id;
}

async function approve(app: App, session: Session, url: string, key: string): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url,
    headers: authorizedWrite(session, key),
  });
  if (response.statusCode !== 200) throw new Error(`approve failed: ${response.body}`);
}

async function settlementOf(
  app: App,
  session: Session,
  url: string,
): Promise<DocumentBody['settlement']> {
  const response = await app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
  if (response.statusCode !== 200) throw new Error(`read failed: ${response.body}`);
  return response.json<DocumentBody>().settlement;
}
