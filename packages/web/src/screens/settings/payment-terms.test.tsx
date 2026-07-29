import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Loaded after `./test-support` — see that module's own header for why a static import of
 * the section here, ahead of the fetch/Request stub, would fail every request in this file.
 */
const { PaymentTermsSection } = await import('./payment-terms');

/**
 * Payment terms (OB-136, OB-140; ROADMAP D-79, D-106, D-107).
 *
 * Two things are worth a test here. **Simple and rich read differently**: a term with no
 * discount says so in words, not a blank cell that could be mistaken for a loading gap.
 * **The percentage is a client-side convention, not the wire's**: `discountRatePpm` is
 * parts-per-million (`20000` is 2%) and this form is the one place in the app that
 * converts, both ways, so the request the server receives and the number the operator
 * typed are asserted against each other rather than each in isolation.
 */

const SIMPLE_TERM = {
  id: 'term-simple',
  name: 'Net 30',
  netDays: 30,
  discountRatePpm: null,
  discountWindowDays: null,
  isActive: true,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

const RICH_TERM = {
  id: 'term-rich',
  name: '2/10 Net 30',
  netDays: 30,
  discountRatePpm: 20000,
  discountWindowDays: 10,
  isActive: true,
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-01-05T09:00:00.000Z',
};

function listRoute(terms: readonly unknown[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/payment-terms',
    reply: () => ({ status: 200, body: { paymentTerms: terms } }),
  };
}

describe('PaymentTermsSection', () => {
  it('reads a simple term and a rich one differently, and never as a blank cell', async () => {
    installApiStub([listRoute([SIMPLE_TERM, RICH_TERM])]);
    renderWithQueryClient(<PaymentTermsSection />);

    expect(await screen.findByText('Net 30')).toBeInTheDocument();
    expect(screen.getByText('None — a simple term')).toBeInTheDocument();
    expect(screen.getByText('2/10 Net 30')).toBeInTheDocument();
    expect(screen.getByText('2% within 10 days')).toBeInTheDocument();
  });

  it('creates a simple term with no discount fields sent at all', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/payment-terms',
        reply: ({ body }) => ({
          status: 201,
          body: { ...SIMPLE_TERM, name: (body as { name: string }).name },
        }),
      },
    ]);
    renderWithQueryClient(<PaymentTermsSection />);

    await user.click(await screen.findByRole('button', { name: 'New payment term' }));
    const dialog = await screen.findByRole('dialog', { name: 'New payment term' });

    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Due on receipt');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Net days' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Net days' }), '0');
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.body).toEqual({ name: 'Due on receipt', netDays: 0 });
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('converts a typed percentage to parts-per-million on the wire', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      listRoute([]),
      {
        method: 'POST',
        path: '/v1/payment-terms',
        reply: () => ({ status: 201, body: RICH_TERM }),
      },
    ]);
    renderWithQueryClient(<PaymentTermsSection />);

    await user.click(await screen.findByRole('button', { name: 'New payment term' }));
    const dialog = await screen.findByRole('dialog', { name: 'New payment term' });

    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), '2/10 Net 30');
    await user.clear(within(dialog).getByRole('spinbutton', { name: 'Net days' }));
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Net days' }), '30');
    await user.click(
      within(dialog).getByRole('checkbox', { name: 'Includes an early-pay discount' }),
    );
    await user.type(within(dialog).getByRole('spinbutton', { name: 'Discount rate (%)' }), '2');
    await user.type(
      within(dialog).getByRole('spinbutton', { name: 'Discount window (days)' }),
      '10',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(stub.calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.body).toEqual({
      name: '2/10 Net 30',
      netDays: 30,
      discountRatePpm: 20000,
      discountWindowDays: 10,
    });
  });

  it('archives a term as a one-way, idempotent action — not a delete', async () => {
    const user = userEvent.setup();
    const stub = installApiStub([
      listRoute([SIMPLE_TERM]),
      {
        method: 'POST',
        path: '/v1/payment-terms/:paymentTermId/deactivate',
        reply: () => ({ status: 200, body: { ...SIMPLE_TERM, isActive: false } }),
      },
    ]);
    renderWithQueryClient(<PaymentTermsSection />);

    await user.click(await screen.findByRole('button', { name: 'Archive Net 30' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive this payment term?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));

    await waitFor(() => {
      expect(
        stub.calls.some(
          (call) =>
            call.method === 'POST' && call.path === '/v1/payment-terms/term-simple/deactivate',
        ),
      ).toBe(true);
    });
  });
});
