import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { ErrorBanner } from '../../components';
import { AmountCell, DrillLink } from './cells';
import type { ReportFilterState } from './filters';
import { ReportPending, ReportTitle } from './layout';

/**
 * The trial balance (A2), and the oracle the other three are read against.
 *
 * It takes one upper bound and nothing else — no range, no dimension filter, no slice. That
 * is M1's contract and it is not an oversight the screen should paper over: the whole point
 * of the report is to be the unconditional statement of what the ledger contains, which is
 * why every property in OB-053 checks the other reports against it. `UnusedControlNotice`
 * in the toolbar tells the reader which of their controls stopped applying.
 *
 * `difference` is printed unconditionally rather than only when non-zero. The endpoint
 * reports it rather than asserting it, deliberately, so that a discrepancy is a fact on
 * screen instead of an exception someone swallowed; a field that appears only when it is
 * bad is a field a reader learns to stop looking for.
 */

type TrialBalance = components['schemas']['TrialBalance'];

export interface TrialBalanceViewProps {
  readonly state: ReportFilterState;
  readonly onDrillThrough: (accountId: string) => void;
}

export function TrialBalanceView({ state, onDrillThrough }: TrialBalanceViewProps): ReactElement {
  // Omitted rather than sent empty: no `asOf` means every posting to date, which is a
  // report the endpoint offers and an empty string is not a date.
  const asOf = state.to === '' ? undefined : state.to;
  const report = useQuery({
    queryKey: ['reports', 'trial-balance', { asOf }],
    queryFn: async (): Promise<TrialBalance> =>
      unwrap(
        await api.GET('/v1/reports/trial-balance', {
          params: { query: asOf === undefined ? {} : { asOf } },
        }),
      ),
  });

  if (report.isPending) return <ReportPending />;
  if (report.isError) {
    return (
      <ErrorBanner
        error={report.error}
        onRetry={() => {
          void report.refetch();
        }}
      />
    );
  }

  return <TrialBalanceReport report={report.data} onDrillThrough={onDrillThrough} />;
}

export function TrialBalanceReport({
  report,
  onDrillThrough,
}: {
  readonly report: TrialBalance;
  readonly onDrillThrough: (accountId: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <ReportTitle
        title="Trial balance"
        subtitle={report.asOf === null ? 'Every posting to date' : `As at ${report.asOf}`}
      />

      <table aria-label="Trial balance" className="w-full border-collapse text-base">
        <thead>
          <tr className="border-b border-border text-xs text-text-subtle">
            <th scope="col" className="px-3 py-1 text-left font-medium">
              Account
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Debits
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Credits
            </th>
            <th scope="col" className="px-3 py-1 text-right font-medium">
              Balance
            </th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row) => (
            <tr key={row.accountId} className="border-b border-border last:border-0">
              <th scope="row" className="px-3 py-1 text-left font-normal">
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-text-subtle">{row.code}</span>
                  <DrillLink
                    onClick={() => {
                      onDrillThrough(row.accountId);
                    }}
                    title="Show the entries behind this line"
                  >
                    {row.name}
                  </DrillLink>
                </span>
              </th>
              <AmountCell value={row.debits} />
              <AmountCell value={row.credits} />
              <AmountCell value={row.balance} />
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong">
            <th scope="row" className="px-3 py-1 text-left font-semibold">
              Totals
            </th>
            <AmountCell value={report.totalDebits} emphasis />
            <AmountCell value={report.totalCredits} emphasis />
            <td />
          </tr>
          <tr>
            <th scope="row" className="px-3 py-1 text-left font-medium text-text-muted">
              Difference
            </th>
            <td />
            <td />
            <AmountCell value={report.difference} emphasis />
          </tr>
        </tfoot>
      </table>

      <p className="text-xs text-text-subtle">
        A consistent ledger has a difference of 0.00. It is reported rather than asserted, so a
        discrepancy is visible instead of being turned into an error.
      </p>
    </div>
  );
}
