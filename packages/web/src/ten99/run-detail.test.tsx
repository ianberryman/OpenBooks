import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Ten99Form, Ten99Run } from '@openbooks/shared-types';

import { Ten99RunDetail } from './run-detail';

/**
 * One run's detail (OB-228 Wave-1 Stream D). `./queries` mocked at the hook boundary.
 * Worth asserting: "Download Copy B" points at the on-demand render route
 * (`/v1/ten99/forms/{id}/pdf`) built from the form id, NOT the wire form's `downloadUrl` —
 * that field is a signed URL to a deterministic storage key nothing renders eagerly, so a
 * cold link 404s ("No such artifact"); the render route renders-stores-streams in one call.
 * The href is asserted to ignore `downloadUrl` so the fixed wiring cannot silently regress.
 * And e-file is only offered on a `generated` run — D-228-6's "nothing about this transmit
 * action bypasses server-side gating" made legible in the one client-side way that is safe
 * to assert, the enabled/disabled state.
 */

const mocks = vi.hoisted(() => ({
  useTen99Run: vi.fn(),
  useEfileTen99Run: vi.fn(),
}));

vi.mock('./queries', () => ({
  useTen99Run: mocks.useTen99Run,
  useEfileTen99Run: mocks.useEfileTen99Run,
}));

function form(partial: Partial<Ten99Form>): Ten99Form {
  return {
    id: 'form-1',
    runId: 'run-1',
    contactId: 'vendor-1',
    contactName: 'Acme Supplies',
    formType: '1099_nec',
    boxCode: 'nec_1',
    amountMinor: '75000',
    recipientLegalName: 'Acme Supplies LLC',
    recipientTinLast4: '1234',
    correctsFormId: null,
    downloadUrl: 'https://files.example.test/form-1.pdf',
    createdAt: '2026-01-15T00:00:00.000Z',
    ...partial,
  };
}

function run(partial: Partial<Ten99Run>): Ten99Run {
  return {
    id: 'run-1',
    taxYear: 2025,
    status: 'generated',
    efileProvider: null,
    efileRef: null,
    thresholdMinor: '60000',
    generatedByUserId: 'user-1',
    createdAt: '2026-01-15T00:00:00.000Z',
    forms: [form({})],
    ...partial,
  };
}

function stubEfile(mutate: (variables: unknown) => void = vi.fn()): void {
  mocks.useEfileTen99Run.mockReturnValue({
    mutate,
    isPending: false,
    isError: false,
    error: null,
  });
}

describe('Ten99RunDetail', () => {
  it('links Copy B to the on-demand render route built from the form id', () => {
    mocks.useTen99Run.mockReturnValue({
      isPending: false,
      isSuccess: true,
      data: run({}),
      error: null,
      refetch: () => {},
    });
    stubEfile();

    render(<Ten99RunDetail runId="run-1" onBack={() => {}} />);

    expect(screen.getByRole('link', { name: 'Download Copy B' })).toHaveAttribute(
      'href',
      '/v1/ten99/forms/form-1/pdf',
    );
  });

  it('ignores downloadUrl entirely — the Copy B href is the render route, never the storage key', () => {
    mocks.useTen99Run.mockReturnValue({
      isPending: false,
      isSuccess: true,
      data: run({
        forms: [form({ id: 'form-9', downloadUrl: 'https://files.example.test/stale.pdf' })],
      }),
      error: null,
      refetch: () => {},
    });
    stubEfile();

    render(<Ten99RunDetail runId="run-1" onBack={() => {}} />);

    expect(screen.getByRole('link', { name: 'Download Copy B' })).toHaveAttribute(
      'href',
      '/v1/ten99/forms/form-9/pdf',
    );
  });

  it('enables e-file on a generated run and submits the manual provider', async () => {
    const mutate = vi.fn();
    mocks.useTen99Run.mockReturnValue({
      isPending: false,
      isSuccess: true,
      data: run({ status: 'generated' }),
      error: null,
      refetch: () => {},
    });
    stubEfile(mutate);
    const user = userEvent.setup();

    render(<Ten99RunDetail runId="run-1" onBack={() => {}} />);

    const button = screen.getByRole('button', { name: 'E-file (manual)' });
    expect(button).toBeEnabled();
    await user.click(button);

    expect(mutate).toHaveBeenCalledTimes(1);
    const body = mutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body['runId']).toBe('run-1');
    expect(body['provider']).toBe('manual');
  });

  it('disables e-file once the run has already been submitted', () => {
    mocks.useTen99Run.mockReturnValue({
      isPending: false,
      isSuccess: true,
      data: run({ status: 'submitted', efileProvider: 'manual', efileRef: 'ref-9' }),
      error: null,
      refetch: () => {},
    });
    stubEfile();

    render(<Ten99RunDetail runId="run-1" onBack={() => {}} />);

    expect(screen.getByRole('button', { name: 'E-file (manual)' })).toBeDisabled();
    expect(screen.getByText(/Submitted via manual — ref-9/)).toBeInTheDocument();
  });
});
