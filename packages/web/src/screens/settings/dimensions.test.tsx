import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { StubRoute } from './test-support';
import { installApiStub, preconditionFailed, renderWithQueryClient } from './test-support';

/**
 * Dimensions (OB-050; D-18, D-29).
 *
 * Two things are worth a test and the rest is not. **Archive and delete must not read as
 * two words for the same thing**: a value journal lines carry can only be archived, the
 * server says so with `dimension_value_in_use`, and a screen that offered one control
 * would either refuse a legitimate delete or hide the only removal an in-use value has.
 * And **the eight-axis bound has to be visible before it bites** — an org that learns it
 * after naming a ninth axis has already done the work the refusal throws away.
 */
const { DimensionsSection } = await import('./dimensions');

interface Axis {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
}

interface Value {
  id: string;
  dimensionId: string;
  code: string;
  name: string;
  isActive: boolean;
}

const TIMESTAMPS = { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };

function axis(code: string, name: string, isActive = true): Axis {
  return { id: `axis-${code}`, code, name, description: null, isActive };
}

function value(dimensionId: string, code: string, name: string): Value {
  return { id: `value-${code}`, dimensionId, code, name, isActive: true };
}

function listRoutes(axes: readonly Axis[], values: readonly Value[]): StubRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/dimensions',
      reply: () => ({
        status: 200,
        body: { items: axes.map((item) => ({ ...item, ...TIMESTAMPS })), nextCursor: null },
      }),
    },
    {
      method: 'GET',
      path: '/v1/dimensions/:dimensionId/values',
      reply: ({ params }) => ({
        status: 200,
        body: {
          items: values
            .filter((item) => item.dimensionId === params['dimensionId'])
            .map((item) => ({ ...item, ...TIMESTAMPS })),
          nextCursor: null,
        },
      }),
    },
  ];
}

describe('DimensionsSection', () => {
  it('counts archived axes against the bound and says why before the limit is reached', async () => {
    const axes = [
      axis('DEPT', 'Department'),
      axis('LOC', 'Location'),
      axis('PROJ', 'Project'),
      axis('FUND', 'Funding source'),
      axis('PROG', 'Programme'),
      axis('CAMP', 'Campaign', false),
      axis('VEH', 'Vehicle'),
    ];
    installApiStub(listRoutes(axes, []));
    renderWithQueryClient(<DimensionsSection />);

    expect(await screen.findByText('7 of 8 axes (1 archived)')).toBeInTheDocument();
    // Stated at seven rather than at eight: the fact that archiving does not free a slot is
    // only useful while there is still a decision to make.
    expect(screen.getByText('1 more axis can be defined')).toBeInTheDocument();
    expect(screen.getByText(/archived ones are counted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New axis' })).toBeEnabled();
  });

  it('refuses the ninth axis in the UI rather than only relaying the server refusal', async () => {
    const axes = Array.from({ length: 8 }, (_unused, index) =>
      axis(`AX${String(index)}`, `Axis ${String(index)}`),
    );
    installApiStub(listRoutes(axes, []));
    renderWithQueryClient(<DimensionsSection />);

    expect(await screen.findByText('8 of 8 axes')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'New axis' })).toBeDisabled();
    });
    expect(
      screen.getByText('This organization has all eight axes it may define'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Deleting an axis that has no values is what frees a slot/i),
    ).toBeInTheDocument();
  });

  it('offers archive and delete as separate controls on a value', async () => {
    const dept = axis('DEPT', 'Department');
    installApiStub(listRoutes([dept], [value(dept.id, 'SALES', 'Sales team')]));
    const user = userEvent.setup();
    renderWithQueryClient(<DimensionsSection />);

    await user.click(await screen.findByRole('button', { name: 'Values' }));

    const row = (await screen.findByText('SALES')).closest('tr');
    expect(row).not.toBeNull();
    const controls = within(row as HTMLElement);
    expect(controls.getByRole('button', { name: 'Archive Sales team' })).toBeInTheDocument();
    expect(controls.getByRole('button', { name: 'Delete Sales team' })).toBeInTheDocument();
  });

  it('turns a refused delete of an in-use value into the archive that will work', async () => {
    const dept = axis('DEPT', 'Department');
    const sales = value(dept.id, 'SALES', 'Sales team');
    const stub = installApiStub([
      {
        method: 'DELETE',
        path: '/v1/dimension-values/:valueId',
        reply: () =>
          preconditionFailed(
            'dimension_value_in_use',
            'This value is carried by journal lines and cannot be deleted. Archive it instead.',
          ),
      },
      {
        method: 'POST',
        path: '/v1/dimension-values/:valueId/archive',
        reply: () => ({ status: 200, body: { ...sales, isActive: false, ...TIMESTAMPS } }),
      },
      ...listRoutes([dept], [sales]),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<DimensionsSection />);

    await user.click(await screen.findByRole('button', { name: 'Values' }));
    await user.click(await screen.findByRole('button', { name: 'Delete Sales team' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete value' });
    // The distinction is stated before the press, not only after the refusal.
    expect(
      within(dialog).getByText(/archiving is the only removal available/i),
    ).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete value' }));

    await waitFor(() => {
      expect(within(dialog).getByText('Entries carry this value')).toBeInTheDocument();
    });
    // The server's own message, not a generic one: it is the specific half of the refusal.
    expect(within(dialog).getByText(/carried by journal lines/i)).toBeInTheDocument();

    const archiveInstead = within(dialog).getByRole('button', { name: 'Archive instead' });
    expect(within(dialog).queryByRole('button', { name: 'Delete value' })).toBeNull();

    await user.click(archiveInstead);

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/dimension-values/:valueId/archive')).toHaveLength(1);
    });
    // Two intents, two keys — the delete's key is not reused for the archive, which is a
    // different request and would be an `idempotency_key_conflict` if it were.
    const deleteKeys = stub.keysFor('DELETE', '/v1/dimension-values/:valueId');
    const archiveKeys = stub.keysFor('POST', '/v1/dimension-values/:valueId/archive');
    expect(deleteKeys[0]).not.toBe(archiveKeys[0]);
    expect(archiveKeys[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates an axis with one idempotency key and the code the user typed', async () => {
    const stub = installApiStub([
      {
        method: 'POST',
        path: '/v1/dimensions',
        reply: ({ body }) => ({
          status: 201,
          body: { ...(body as object), id: 'axis-new', isActive: true, ...TIMESTAMPS },
        }),
      },
      ...listRoutes([], []),
    ]);
    const user = userEvent.setup();
    renderWithQueryClient(<DimensionsSection />);

    await user.click(await screen.findByRole('button', { name: 'New axis' }));
    const dialog = await screen.findByRole('dialog', { name: 'New axis' });
    await user.type(within(dialog).getByLabelText('Code'), 'DEPT');
    await user.type(within(dialog).getByLabelText('Name'), 'Department');
    await user.click(within(dialog).getByRole('button', { name: 'Create axis' }));

    await waitFor(() => {
      expect(stub.keysFor('POST', '/v1/dimensions')).toHaveLength(1);
    });
    expect(stub.calls.find((call) => call.method === 'POST')?.body).toEqual({
      code: 'DEPT',
      name: 'Department',
      description: null,
    });
  });
});
