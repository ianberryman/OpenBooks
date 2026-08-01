import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../../query/client';
import { DocumentView } from './document-view';
import type { Account, Contact, Invoice, SalesReferenceData } from './queries';

/**
 * Sending an invoice from the document view (OB-131, Phase 1, S4).
 *
 * `sendInvoice` goes through `./delivery-client.ts`'s `thinRequest`, not the generated
 * `openapi-fetch` client — `/v1/invoices/{id}/send` is not in `schema.d.ts` yet (S5 lands
 * it in parallel) — so the stub here is a plain `globalThis.fetch` mock rather than the
 * `installApiStub` harness `screens/settings/test-support.tsx` provides, for the same
 * "stub at the network boundary and nothing above it" principle.
 *
 * Two things are worth asserting: the request carries an idempotency key and an absent
 * `recipientEmail` when the override field is left blank (never `recipientEmail: ''`,
 * which is a real, wrong value on the wire), and the resulting delivery — its status and
 * its public link — is what the screen shows afterward.
 */
vi.mock('../../env', () => ({ API_BASE_URL: 'http://openbooks.test' }));

const CONTACT: Contact = {
  id: 'contact-1',
  displayName: 'Acme Supplies',
  code: null,
  email: 'ap@acme.test',
  phone: null,
  legalName: null,
  notes: null,
  isActive: true,
  isCustomer: true,
  isVendor: false,
  isEmployee: false,
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const ACCOUNT: Account = {
  id: 'account-1',
  code: '4000',
  name: 'Sales',
  description: null,
  type: 'revenue',
  normalBalance: 'credit',
  parentAccountId: null,
  cashBasisRole: null,
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function invoice(status: Invoice['status']): Invoice {
  return {
    id: 'invoice-1',
    contactId: CONTACT.id,
    documentNumber: 'INV-0001',
    reference: null,
    issueDate: '2026-01-15',
    dueDate: '2026-02-14',
    taxMode: 'exclusive',
    memo: null,
    status,
    journalId: status === 'draft' ? null : 'journal-1',
    voidJournalId: null,
    lines: [
      {
        lineId: '1',
        lineNumber: 1,
        description: 'Consulting',
        quantity: '1',
        accountId: ACCOUNT.id,
        unitAmount: '100000',
        netAmount: '100000',
        taxAmount: '0',
        grossAmount: '100000',
        taxRateId: null,
        taxRatePercentage: null,
        dimensionValueIds: [],
        catalogItemId: null,
      },
    ],
    totals: { net: '100000', tax: '0', gross: '100000' },
    taxSummary: [],
    settlement: { allocated: '0', outstanding: '100000' },
    allocations: [],
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
}

function reference(): SalesReferenceData {
  return {
    contacts: [CONTACT],
    accounts: [ACCOUNT],
    taxRates: [],
    contactsById: new Map([[CONTACT.id, CONTACT]]),
    accountsById: new Map([[ACCOUNT.id, ACCOUNT]]),
    taxRatesById: new Map(),
  };
}

function renderView(document: Invoice): void {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <DocumentView
        document={document}
        kind="invoice"
        reference={reference()}
        onBack={() => {}}
        onChanged={() => {}}
      />
    </QueryClientProvider>,
  );
}

interface Call {
  readonly method: string;
  readonly path: string;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

function stubSend(reply: { status: number; body: unknown }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        idempotencyKey: headers.get('idempotency-key'),
        body: init?.body === undefined ? undefined : JSON.parse(init.body as string),
      });
      return Promise.resolve(
        new Response(JSON.stringify(reply.body), {
          status: reply.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return calls;
}

describe('sending an invoice from the document view', () => {
  it('offers Send on an approved invoice and not on a void one', () => {
    renderView(invoice('approved'));
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('offers no Send on a void invoice', () => {
    renderView(invoice('void'));
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('sends with no recipientEmail when blank, carrying one idempotency key', async () => {
    const calls = stubSend({
      status: 200,
      body: {
        id: 'delivery-1',
        invoiceId: 'invoice-1',
        recipientEmail: 'ap@acme.test',
        sentAt: '2026-01-16T00:00:00.000Z',
        artifactStorageKey: 'artifacts/invoice-1.pdf',
        providerMessageId: 'msg-1',
        status: 'sent',
        publicUrl: 'https://openbooks.test/i/abc123.def456',
        createdAt: '2026-01-16T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderView(invoice('approved'));

    await user.click(screen.getByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send this invoice?' });
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/invoices/invoice-1/send');
    expect(calls[0]?.body).toEqual({});
    expect(calls[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText('Sent to ap@acme.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Hosted invoice link' })).toHaveAttribute(
      'href',
      'https://openbooks.test/i/abc123.def456',
    );
  });

  it('sends the typed override rather than the contact’s email', async () => {
    const calls = stubSend({
      status: 200,
      body: {
        id: 'delivery-2',
        invoiceId: 'invoice-1',
        recipientEmail: 'billing@example.test',
        sentAt: '2026-01-16T00:00:00.000Z',
        artifactStorageKey: 'artifacts/invoice-1.pdf',
        providerMessageId: null,
        status: 'sent',
        publicUrl: 'https://openbooks.test/i/xyz789.secret',
        createdAt: '2026-01-16T00:00:00.000Z',
      },
    });
    const user = userEvent.setup();
    renderView(invoice('approved'));

    await user.click(screen.getByRole('button', { name: 'Send' }));
    const dialog = await screen.findByRole('dialog', { name: 'Send this invoice?' });
    await user.type(
      within(dialog).getByLabelText('Send to a different address'),
      'billing@example.test',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.body).toEqual({ recipientEmail: 'billing@example.test' });
  });
});
