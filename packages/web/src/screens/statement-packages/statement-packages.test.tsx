import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, renderWithQueryClient } from './test-support';

/**
 * Statement packages (initiative P, OB-195).
 *
 * Two things are worth a test. **A generate carries one idempotency key and a body naming
 * only what was actually chosen** — `basis` absent when "Org default" is left selected,
 * matching `CreateStatementPackageRequest`'s own "absent uses the org's basis" contract
 * rather than this screen inventing a default value to send. **A rendered package's
 * download link is the exact `downloadUrl` the list returned** — a freshly signed URL
 * minted on that read (`statement-package.ts`), not a link this screen constructs.
 */
const { StatementPackagesScreen } = await import('../statement-packages');

const PACKAGE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function packagesRoute(items: readonly Record<string, unknown>[]): StubRoute {
  return {
    method: 'GET',
    path: '/v1/statement-packages',
    reply: () => ({ status: 200, body: { packages: items } }),
  };
}

describe('StatementPackagesScreen', () => {
  it('says nothing has been rendered yet, and lists what has once it has', async () => {
    installApiStub([packagesRoute([])]);
    renderWithQueryClient(<StatementPackagesScreen />);

    expect(await screen.findByText('No packages rendered yet.')).toBeInTheDocument();
  });

  it('shows a rendered package with its own download link and author', async () => {
    installApiStub([
      packagesRoute([
        {
          id: PACKAGE_ID,
          periodStart: '2026-03-01',
          periodEnd: '2026-03-31',
          basis: 'accrual',
          downloadUrl: 'https://storage.example/statement-packages/march.pdf?sig=abc',
          generatedByUserId: USER_ID,
          generatedByName: 'Ada Lovelace',
          createdAt: '2026-04-01T09:00:00.000Z',
        },
      ]),
    ]);
    renderWithQueryClient(<StatementPackagesScreen />);

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Download PDF' });
    expect(link).toHaveAttribute(
      'href',
      'https://storage.example/statement-packages/march.pdf?sig=abc',
    );
  });

  it('generates with one key and omits basis when the org default is left chosen', async () => {
    const stub = installApiStub([
      packagesRoute([]),
      {
        method: 'POST',
        path: '/v1/statement-packages',
        reply: ({ body }) => ({
          status: 201,
          body: {
            id: PACKAGE_ID,
            ...(body as Record<string, unknown>),
            basis: 'accrual',
            downloadUrl: 'https://storage.example/statement-packages/new.pdf',
            generatedByUserId: USER_ID,
            generatedByName: 'Ada Lovelace',
            createdAt: '2026-04-01T09:00:00.000Z',
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<StatementPackagesScreen />);

    await screen.findByText('No packages rendered yet.');

    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-03-31' } });

    const submit = screen.getByRole('button', { name: 'Generate package' });
    await waitFor(() => {
      expect(submit).toBeEnabled();
    });
    await user.click(submit);

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/statement-packages')).toHaveLength(1);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.body).toEqual({ periodStart: '2026-03-01', periodEnd: '2026-03-31' });
    expect(posted?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends the chosen basis when it is not the org default', async () => {
    const stub = installApiStub([
      packagesRoute([]),
      {
        method: 'POST',
        path: '/v1/statement-packages',
        reply: ({ body }) => ({
          status: 201,
          body: {
            id: PACKAGE_ID,
            ...(body as Record<string, unknown>),
            downloadUrl: 'https://storage.example/statement-packages/new.pdf',
            generatedByUserId: USER_ID,
            generatedByName: 'Ada Lovelace',
            createdAt: '2026-04-01T09:00:00.000Z',
          },
        }),
      },
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<StatementPackagesScreen />);

    await screen.findByText('No packages rendered yet.');

    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-03-31' } });

    await user.click(screen.getByRole('combobox', { name: 'Basis' }));
    await user.click(await screen.findByRole('option', { name: 'Cash' }));

    await user.click(screen.getByRole('button', { name: 'Generate package' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/statement-packages')).toHaveLength(1);
    });
    const posted = stub.calls.find((call) => call.method === 'POST');
    expect(posted?.body).toEqual({
      periodStart: '2026-03-01',
      periodEnd: '2026-03-31',
      basis: 'cash',
    });
  });
});
