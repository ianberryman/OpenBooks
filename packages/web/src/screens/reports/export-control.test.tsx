import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { buildExportUrl, ExportControl } from './export-control';
import { initialFilterState } from './filters';

/**
 * The reports "Export" action (OB-220 part 2).
 *
 * `buildExportUrl` is the part worth unit-testing directly: it is the one place a filter
 * gets turned into the querystring the download endpoint reads, and doing that through the
 * rendered buttons would mean asserting on `HTMLAnchorElement.href` through a mocked
 * `document.createElement` for every case. The component tests below cover the one thing
 * `buildExportUrl` cannot: that the general ledger's buttons are actually disabled, and
 * that the three out-of-scope tabs render nothing at all.
 */

describe('buildExportUrl', () => {
  it('builds the trial balance URL from `to` alone', () => {
    const url = buildExportUrl('trial-balance', 'csv', initialFilterState('2026-06-30'), null);

    expect(url).toBe('/v1/reports/export?report=trial-balance&asOf=2026-06-30&format=csv');
  });

  it('returns null for the trial balance with no `to` date', () => {
    const url = buildExportUrl(
      'trial-balance',
      'csv',
      { ...initialFilterState('2026-06-30'), to: '' },
      null,
    );

    expect(url).toBeNull();
  });

  it('carries `from`, `to` and `basis` for profit and loss', () => {
    const filters = {
      ...initialFilterState('2026-06-30'),
      from: '2026-01-01',
      basis: 'cash' as const,
    };
    const url = buildExportUrl('profit-and-loss', 'xlsx', filters, null);

    expect(url).toBe(
      '/v1/reports/export?report=profit-and-loss&from=2026-01-01&to=2026-06-30' +
        '&basis=cash&format=xlsx',
    );
  });

  it('sends the balance sheet as `asOf`, with no basis', () => {
    const url = buildExportUrl('balance-sheet', 'csv', initialFilterState('2026-06-30'), null);

    expect(url).toBe('/v1/reports/export?report=balance-sheet&asOf=2026-06-30&format=csv');
  });

  it('returns null for the general ledger with no account chosen', () => {
    const url = buildExportUrl('general-ledger', 'csv', initialFilterState('2026-06-30'), null);

    expect(url).toBeNull();
  });

  it('carries the account id once one is chosen', () => {
    const url = buildExportUrl(
      'general-ledger',
      'csv',
      { ...initialFilterState('2026-06-30'), from: '2026-01-01' },
      'acct-1',
    );

    expect(url).toBe(
      '/v1/reports/export?report=general-ledger&from=2026-01-01&to=2026-06-30' +
        '&accountId=acct-1&format=csv',
    );
  });

  it('carries `from`/`to` for cash flow, with no basis or account', () => {
    const url = buildExportUrl('cash-flow', 'xlsx', initialFilterState('2026-06-30'), null);

    expect(url).toBe('/v1/reports/export?report=cash-flow&to=2026-06-30&format=xlsx');
  });

  it('returns null for the tabs the export endpoint does not cover', () => {
    const filters = initialFilterState('2026-06-30');
    expect(buildExportUrl('cash-flow-projection', 'csv', filters, null)).toBeNull();
    expect(buildExportUrl('budget-vs-actual', 'csv', filters, null)).toBeNull();
    expect(buildExportUrl('audit', 'csv', filters, null)).toBeNull();
  });
});

describe('ExportControl', () => {
  it('renders nothing for a view the export endpoint does not cover', () => {
    const { container } = render(
      <ExportControl
        view="audit"
        filters={initialFilterState('2026-06-30')}
        ledgerAccountId={null}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('disables both buttons on the general ledger until an account is chosen', () => {
    render(
      <ExportControl
        view="general-ledger"
        filters={initialFilterState('2026-06-30')}
        ledgerAccountId={null}
      />,
    );

    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export Excel' })).toBeDisabled();
    expect(screen.getByText('Choose an account to export')).toBeInTheDocument();
  });

  it('enables the buttons once an account is chosen, and downloads on click', async () => {
    const user = userEvent.setup();

    render(
      <ExportControl
        view="general-ledger"
        filters={initialFilterState('2026-06-30')}
        ledgerAccountId="acct-1"
      />,
    );

    const button = screen.getByRole('button', { name: 'Export CSV' });
    expect(button).not.toBeDisabled();

    // Spied only for the click, so rendering itself still uses jsdom's real
    // `createElement` — mocking it earlier would make every host element in the tree
    // the same anchor node.
    const anchor = document.createElement('a');
    const clicked = vi.spyOn(anchor, 'click').mockImplementation(() => {});
    const createElement = vi.spyOn(document, 'createElement').mockReturnValue(anchor);

    await user.click(button);

    expect(clicked).toHaveBeenCalledOnce();
    expect(anchor.href).toContain('/v1/reports/export?report=general-ledger');
    expect(anchor.href).toContain('accountId=acct-1');
    expect(anchor.href).toContain('format=csv');

    createElement.mockRestore();
  });
});
