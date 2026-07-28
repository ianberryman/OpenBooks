import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';

import { api, unwrap } from '../../api';
import type { components } from '../../api';
import { ErrorBanner } from '../../components';
import { cx } from '../../lib/cx';
import { AmountCell } from './cells';
import type { ReportFilterState } from './filters';
import { rangeQuery } from './filters';
import { BasisBadge, ReportPending, ReportTitle, describeRange } from './layout';

/**
 * The Statement of Cash Flows, indirect method (OB-157; D-88).
 *
 * ## No sections, no drill-through
 *
 * Every other viewer in this directory prints a hierarchy of accounts, because a P&L and a
 * balance sheet are each a projection over the whole chart. This statement is not: it prints
 * three figures the server already reconciled — net income, the change in cash, and the
 * difference between them — and there is no per-account row behind any of the three to drill
 * into. `netIncome` is the P&L's own total, already summed there; `adjustments` is a plug by
 * definition, not a sum of anything a reader could look inside; and the cash accounts'
 * movement is itself a total the server took over more than one account. Sending a click on
 * any of them to the general ledger would need an account id this response does not carry.
 *
 * ## Reading `reconciles`
 *
 * `reconciles` is reported rather than hidden behind an assumption that it always holds. It
 * is true by construction on this server — `adjustments` is defined as the figure that makes
 * it true — so a `false` here would mean the arithmetic itself broke, not that the business
 * had an unusual period. It is shown anyway, following the balance sheet's own choice to
 * report a footing rather than assert it silently.
 */

type StatementOfCashFlows = components['schemas']['StatementOfCashFlows'];

export interface CashFlowViewProps {
  readonly state: ReportFilterState;
}

export function CashFlowView({ state }: CashFlowViewProps): ReactElement {
  const query = rangeQuery(state);
  const report = useQuery({
    queryKey: ['reports', 'cash-flow', query],
    queryFn: async (): Promise<StatementOfCashFlows> =>
      unwrap(await api.GET('/v1/reports/cash-flow', { params: { query } })),
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

  return <CashFlowReport report={report.data} />;
}

export function CashFlowReport({
  report,
}: {
  readonly report: StatementOfCashFlows;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <ReportTitle
        title="Statement of cash flows"
        subtitle={describeRange(report.range.from, report.range.to)}
        aside={<BasisBadge basis={report.basis} />}
      />
      <p className="text-xs text-text-subtle">
        Net income and the reconciliation to it are shown on the basis above; the change in cash
        itself is always the ledger&rsquo;s cash accounts moving, which is a fact rather than a
        recognition choice.
      </p>

      <table aria-label="Cash flow" className="w-full border-collapse text-base">
        <tbody>
          <Row label="Net income" value={report.netIncome} />
          <Row
            label="Adjustments to reconcile net income to net cash"
            note="Non-cash and working-capital changes, as a single figure — see below."
            value={report.adjustments}
          />
          <Row label="Net change in cash" value={report.netChangeInCash} emphasis rule />
          <Row label="Cash at start of period" value={report.openingCash} />
          <Row label="Cash at end of period" value={report.closingCash} emphasis />
        </tbody>
      </table>

      <ReconciliationNote reconciles={report.reconciles} />
    </div>
  );
}

/**
 * What `adjustments` stands in for, stated so a reader does not take a single line for a
 * completed operating/investing/financing split.
 */
function ReconciliationNote({ reconciles }: { readonly reconciles: boolean }): ReactElement {
  return (
    <p
      className={
        reconciles
          ? 'text-xs text-text-subtle'
          : cx(
              'rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm',
              'text-warning-text',
            )
      }
    >
      {reconciles
        ? 'Net income plus adjustments equals the net change in cash, and opening cash plus ' +
          'that change equals closing cash. This first version reports the reconciliation as ' +
          'one line rather than a categorized operating/investing/financing split, which a ' +
          'fixed-asset register and a per-account activity classification would be needed to ' +
          'derive correctly — a wrong split would be worse than this honest one.'
        : 'The reconciliation does not hold. That is a data or server fault rather than an ' +
          'unusual period — adjustments is defined as the figure that makes it hold — and ' +
          'should be reported rather than trusted.'}
    </p>
  );
}

function Row({
  label,
  note,
  value,
  emphasis,
  rule,
}: {
  readonly label: string;
  readonly note?: string;
  readonly value: string;
  readonly emphasis?: boolean;
  readonly rule?: boolean;
}): ReactElement {
  return (
    <tr className={rule === true ? 'border-t-2 border-border-strong' : 'border-t border-border'}>
      <th scope="row" className="px-3 py-1 text-left font-normal">
        <span className="flex flex-col">
          <span className={emphasis === true ? 'font-semibold' : undefined}>{label}</span>
          {note !== undefined && <span className="text-xs text-text-subtle">{note}</span>}
        </span>
      </th>
      <AmountCell value={value} emphasis={emphasis ?? false} />
    </tr>
  );
}
