import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '../query/client';
import { PublicInvoiceScreen } from './public-invoice';

/**
 * The hosted invoice page (OB-131, Phase 1, S4; the "Pay now" button is OB-150/OB-151).
 *
 * Five things worth a test: it renders a fixture that matches
 * `publicInvoiceViewSchema`'s shape without needing a session (no `/v1/auth/me` call is
 * made — asserted directly, not inferred), a broken or expired token reads as "not
 * available" rather than a raw error, and the PDF link and the branding accent both come
 * through from the response rather than being computed here. The last two are the pay
 * button's own contract: `payable: false` renders nothing extra, and `payable: true`
 * renders a control that posts to the pay-link route and sends the whole tab to whatever
 * URL comes back — never a page this app renders itself (D-83).
 *
 * `fetchPublicInvoiceView` and the pay-link POST both go through `../lib/thin-client.ts`,
 * so the network is stubbed at plain `globalThis.fetch`, the same boundary the sales and
 * settings tests stub at, and nothing above it — the component, the query/mutation hooks
 * and `formatMinorUnits` are all the real ones.
 */
vi.mock('../env', () => ({ API_BASE_URL: 'http://openbooks.test' }));

const VIEW = {
  documentNumber: 'INV-0042',
  reference: 'PO-9',
  issueDate: '2026-01-15',
  dueDate: '2026-02-14',
  lines: [
    {
      description: 'Consulting',
      quantity: '2',
      unitAmount: '50000',
      netAmount: '100000',
      taxAmount: '10000',
      grossAmount: '110000',
    },
  ],
  totals: { net: '100000', tax: '10000', gross: '110000' },
  taxSummary: [{ taxRateName: 'Sales tax', percentage: '10.00', net: '100000', tax: '10000' }],
  memo: 'Thank you for your business.',
  customerName: 'Acme Supplies',
  branding: {
    displayName: 'Northwind Books',
    addressLine1: '1 Trade Street',
    addressLine2: null,
    city: 'Seattle',
    region: 'WA',
    postalCode: '98101',
    country: 'US',
    logoUrl: null,
    // eslint-disable-next-line openbooks/no-raw-color -- fixture: a hex colour value, not a UI style literal
    brandColor: '#1a2b3c',
    invoiceFooter: 'Pay within 30 days.',
  },
  pdfUrl: 'https://openbooks.test/public/invoices/abc123.def456/pdf',
  payable: false,
};

function renderAt(path: string, fetchMock: ReturnType<typeof vi.fn>): void {
  vi.stubGlobal('fetch', fetchMock);
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/i/:token" element={<PublicInvoiceScreen />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the public invoice page', () => {
  it('renders the fixture view with no call to the authenticated identity route', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, VIEW)));
    renderAt('/i/abc123.def456', fetchMock);

    expect(await screen.findByText('Invoice INV-0042')).toBeInTheDocument();
    expect(screen.getByText('Northwind Books')).toBeInTheDocument();
    expect(screen.getByText('Acme Supplies')).toBeInTheDocument();
    expect(screen.getByText('Consulting')).toBeInTheDocument();
    // `formatMinorUnits` reused as-is: a cents-string unit price renders as a fixed two-
    // decimal string, not a float — "500.00" from "50000", never "500" or "500.0000000004".
    expect(screen.getByText('500.00')).toBeInTheDocument();
  });

  it('never calls a /v1 route — the page has no session to use', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push(url.pathname);
      return Promise.resolve(json(200, VIEW));
    });
    renderAt('/i/abc123.def456', fetchMock);

    await screen.findByText('Invoice INV-0042');
    expect(calls.every((path) => !path.startsWith('/v1'))).toBe(true);
    expect(calls).toEqual(['/public/invoices/abc123.def456']);
  });

  it('shows the PDF link and the tax summary from the response, computing neither', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, VIEW)));
    renderAt('/i/abc123.def456', fetchMock);

    await screen.findByText('Invoice INV-0042');
    expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', VIEW.pdfUrl);
    expect(screen.getByText('Sales tax (10.00%)')).toBeInTheDocument();
  });

  it('reads an invalid or expired token as unavailable, not as a raw error', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(json(404, { error: { code: 'not_found', message: 'Not found.' } })),
    );
    renderAt('/i/does-not-exist', fetchMock);

    await waitFor(() => {
      expect(
        screen.getByText(/no longer valid, or the invoice could not be found/i),
      ).toBeInTheDocument();
    });
  });
});

describe('the "Pay now" button (OB-150/OB-151)', () => {
  const originalLocation = window.location;

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  function stubLocation(): { href: string } {
    // Replaced wholesale rather than assigning `window.location.href` directly: jsdom's
    // real `Location` attempts an actual navigation on that assignment and logs a
    // "not implemented" error for every test in this block. A plain object with the one
    // property this button ever touches lets the redirect assertion below be a value
    // check rather than a console-noise tolerance.
    const stub = { href: '' };
    Object.defineProperty(window, 'location', { configurable: true, value: stub });
    return stub;
  }

  it('renders nothing extra when the view is not payable', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json(200, { ...VIEW, payable: false })));
    renderAt('/i/abc123.def456', fetchMock);

    await screen.findByText('Invoice INV-0042');
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument();
    // The download link is unaffected either way.
    expect(screen.getByRole('link', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('posts to the pay-link route and sends the browser to the returned URL when payable', async () => {
    const location = stubLocation();
    const CHECKOUT_URL = 'https://checkout.example.test/session/abc';
    const calls: string[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname === '/public/invoices/abc123.def456/pay-link') {
        return Promise.resolve(json(200, { url: CHECKOUT_URL }));
      }
      return Promise.resolve(json(200, { ...VIEW, payable: true }));
    });
    renderAt('/i/abc123.def456', fetchMock);

    const user = userEvent.setup();
    const payButton = await screen.findByRole('button', { name: 'Pay now' });
    await user.click(payButton);

    await waitFor(() => {
      expect(location.href).toBe(CHECKOUT_URL);
    });
    expect(calls).toContain('POST /public/invoices/abc123.def456/pay-link');
  });

  it('shows the refusal in place, without navigating, when the org has connected no processor', async () => {
    const location = stubLocation();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname === '/public/invoices/abc123.def456/pay-link') {
        return Promise.resolve(
          json(412, {
            error: {
              code: 'precondition_failed',
              message: 'This organization has not connected a payment processor.',
            },
          }),
        );
      }
      return Promise.resolve(json(200, { ...VIEW, payable: true }));
    });
    renderAt('/i/abc123.def456', fetchMock);

    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Pay now' }));

    expect(
      await screen.findByText('This organization has not connected a payment processor.'),
    ).toBeInTheDocument();
    expect(location.href).toBe('');
  });
});
