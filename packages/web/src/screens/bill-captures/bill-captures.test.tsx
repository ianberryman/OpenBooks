import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Bill captures (OB-189).
 *
 * Three things are worth a test at this level. **The review queue shows what extraction
 * found** — filename, source, status and the extracted vendor/total — without anyone
 * opening a capture, the same reason `dimensions.tsx` puts its count on the heading row
 * rather than behind a click. **An upload sends the file's own bytes and content type,
 * base64-encoded, under one idempotency key** — the one thing this screen could get wrong
 * that would be silent until someone opened the resulting capture and found garbage.
 * **Confirming a capture sends `POST .../draft` with the reviewed shape** — the vendor a
 * human chose, the account a human chose per line, and the extracted description/quantity/
 * amount carried through untouched — under its own, separate idempotency key from the
 * upload's.
 */
const { BillCapturesScreen } = await import('../bill-captures');

interface CaptureFixture {
  id: string;
  status: 'extracting' | 'extracted' | 'failed' | 'drafted' | 'dismissed';
  filename: string;
  source: 'upload' | 'email';
  extractedVendorName: string | null;
  matchedContactId: string | null;
  extractedIssueDate: string | null;
  extractedReference: string | null;
  extractedTotalMinor: string | null;
  extractionError: string | null;
  draftedBillId: string | null;
  lines: { description: string | null; quantity: string; unitAmount: string }[];
}

function capture(overrides: Partial<CaptureFixture> = {}): CaptureFixture {
  return {
    id: 'capture-1',
    status: 'extracted',
    filename: 'acme-invoice.pdf',
    source: 'upload',
    extractedVendorName: 'Acme Supplies',
    matchedContactId: 'contact-acme',
    extractedIssueDate: '2026-07-01',
    extractedReference: 'INV-4471',
    extractedTotalMinor: '50000',
    extractionError: null,
    draftedBillId: null,
    lines: [{ description: 'Widgets', quantity: '2', unitAmount: '25000' }],
    ...overrides,
  };
}

const TIMESTAMPS = { createdAt: '2026-07-20T09:00:00.000Z' };

function asWireCapture(fixture: CaptureFixture): unknown {
  return { ...fixture, ...TIMESTAMPS };
}

const VENDOR = {
  id: 'contact-acme',
  code: 'ACME',
  displayName: 'Acme Supplies',
  email: null,
  isActive: true,
  isCustomer: false,
  isVendor: true,
  legalName: null,
  notes: null,
  phone: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const EXPENSE_ACCOUNT = {
  id: 'account-office',
  code: '6100',
  name: 'Office supplies',
  description: null,
  type: 'expense',
  normalBalance: 'debit',
  cashBasisRole: null,
  parentAccountId: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function referenceRoutes(): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/contacts',
      reply: () => ({ status: 200, body: { items: [VENDOR], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/accounts',
      reply: () => ({ status: 200, body: { items: [EXPENSE_ACCOUNT], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/tax-rates',
      reply: () => ({ status: 200, body: { items: [], nextCursor: null } }),
    },
    {
      method: 'GET',
      path: '/v1/bills/inbound-address',
      reply: () => ({ status: 200, body: { address: 'bills-acme@inbound.openbooks.test' } }),
    },
  ];
}

function listRoute(captures: readonly CaptureFixture[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/bills/captures',
    reply: ({ query }) => {
      const status = query.get('status');
      const items = captures.filter((item) => status === null || item.status === status);
      return { status: 200, body: { items: items.map(asWireCapture), nextCursor: null } };
    },
  };
}

describe('BillCapturesScreen', () => {
  it('shows the review queue with what extraction found, and the forward-to address', async () => {
    installApiStub([
      listRoute([capture(), capture({ id: 'capture-2', status: 'drafted' })]),
      ...referenceRoutes(),
    ]);
    renderWithQueryClient(<BillCapturesScreen />);

    const row = (await screen.findByText('acme-invoice.pdf')).closest('tr');
    expect(row).not.toBeNull();
    const withinRow = within(row as HTMLElement);
    expect(withinRow.getByText('Needs review')).toBeInTheDocument();
    expect(withinRow.getByText('Acme Supplies')).toBeInTheDocument();
    expect(withinRow.getByText('$500.00')).toBeInTheDocument();

    // The default filter is `extracted`, so the drafted capture the stub also returns for
    // an unfiltered request must not appear on this screen.
    expect(screen.getAllByRole('row')).toHaveLength(2); // the header row, and this one.

    // The mailbox a bill can be forwarded to, shown before anyone has captured anything by
    // hand — this is the hint that the queue is not upload-only.
    expect(screen.getByText('bills-acme@inbound.openbooks.test')).toBeInTheDocument();
  });

  it('uploads a file as its own bytes and content type, base64-encoded, under one key', async () => {
    const stub = installApiStub([
      listRoute([]),
      ...referenceRoutes(),
      {
        method: 'POST',
        path: '/v1/bills/captures',
        reply: ({ body }) => ({
          status: 201,
          body: { ...capture({ ...(body as Partial<CaptureFixture>) }), ...TIMESTAMPS },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BillCapturesScreen />);

    await screen.findByRole('button', { name: 'Upload a bill' });

    const content = '%PDF-1.4 not a real pdf';
    const file = new File([content], 'utility-bill.pdf', { type: 'application/pdf' });
    const input = screen.getByLabelText('Bill file');
    await user.upload(input, file);

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/bills/captures')).toHaveLength(1);
    });

    const upload = stub.calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/bills/captures',
    );
    const body = upload?.body as { filename: string; contentType: string; content: string };
    expect(body.filename).toBe('utility-bill.pdf');
    expect(body.contentType).toBe('application/pdf');
    expect(body.content).toBe(Buffer.from(content).toString('base64'));
    expect(upload?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('confirms a reviewed capture with the vendor, account and lines chosen on screen', async () => {
    const stub = installApiStub([
      listRoute([capture()]),
      ...referenceRoutes(),
      {
        method: 'POST',
        path: '/v1/bills/captures/:captureId/draft',
        reply: ({ body }) => ({
          status: 201,
          body: { id: 'bill-1', reference: 'INV-4471', ...(body as object) },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<BillCapturesScreen />);

    await user.click(await screen.findByRole('button', { name: 'Review' }));

    const dialog = await screen.findByRole('dialog', { name: 'Review captured bill' });
    // Seeded from the extraction: the matched vendor, the issue date and the vendor's own
    // reference are already filled in, and the one line already carries its description,
    // quantity and amount — only the account is missing, because extraction cannot supply
    // one.
    expect(within(dialog).getByRole('combobox', { name: 'Vendor' })).toHaveValue('Acme Supplies');
    expect(within(dialog).getByLabelText('Issue date')).toHaveValue('2026-07-01');
    expect(within(dialog).getByLabelText(/invoice number/)).toHaveValue('INV-4471');
    expect(within(dialog).getByLabelText('Description, line 1')).toHaveValue('Widgets');

    await user.click(within(dialog).getByRole('combobox', { name: 'Expense account, line 1' }));
    await user.click(await screen.findByRole('option', { name: /Office supplies/ }));

    await user.click(within(dialog).getByRole('button', { name: 'Create draft bill' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/bills/captures/:captureId/draft')).toHaveLength(1);
    });

    const draftCall = stub.calls.find(
      (call) => call.method === 'POST' && call.path === '/v1/bills/captures/capture-1/draft',
    );
    expect(draftCall?.body).toEqual({
      contactId: 'contact-acme',
      issueDate: '2026-07-01',
      taxMode: 'exclusive',
      reference: 'INV-4471',
      memo: null,
      lines: [
        {
          description: 'Widgets',
          quantity: '2',
          accountId: 'account-office',
          unitAmount: '25000',
          taxRateId: null,
        },
      ],
    });
    expect(draftCall?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    // Confirmation, and a way to reach the bill that was created — not a second copy of
    // the purchases screen.
    expect(await screen.findByText('Draft bill created')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Purchases' })).toHaveAttribute(
      'href',
      '/purchases',
    );
  });
});
