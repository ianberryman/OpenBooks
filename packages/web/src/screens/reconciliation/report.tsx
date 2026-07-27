import type { ReactElement } from 'react';

import { ErrorBanner, formatMinorUnits } from '../../components';
import { SignedAmount } from './balances';
import type { ReconcilingItem, UnclearedStatementLine } from './queries';
import { useReconciliationReport } from './queries';

/**
 * The reconciliation report: why the books and the bank do not agree, itemised (OB-083,
 * OB-087; ROADMAP D-50).
 *
 * This is the printable half of a reconciliation — the thing a reconciler reads to find the
 * clearing that is missing or wrong. It has two lists, and keeping them apart is the whole
 * point (D-50):
 *
 * - **Reconciling items** are bank-account ledger movements this session did not clear —
 *   a cheque written and not presented, a deposit in transit. Their signed amounts sum to
 *   `balances.unclearedAmount` exactly (`clearedBalance + Σ items === bookBalance`), and the
 *   footer states that tie so the report is self-checking.
 *
 * - **Uncleared statement lines** are the other direction: lines the *bank* has shown that
 *   the books have not caught. They are shown so the backlog is visible, but they are
 *   **not** part of `unclearedAmount` — a statement line has no journal, so it moves neither
 *   balance in it. Running the two lists into one total would invent a figure that ties to
 *   nothing.
 */

export function ReconciliationReportView({
  sessionId,
}: {
  readonly sessionId: string;
}): ReactElement {
  const report = useReconciliationReport(sessionId);

  if (report.isPending) {
    return <p className="text-text-muted">Loading the reconciliation report…</p>;
  }

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

  const { reconcilingItems, unclearedStatementLines, balances } = report.data;

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-form text-sm text-text-muted">
        The gap between the ledger and the bank, itemised as at {report.data.endDate}. The
        reconciling items are the books&rsquo; own entries the bank has not caught up with; the
        statement lines are the bank&rsquo;s entries the books have not.
      </p>

      <section aria-label="Reconciling items" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text">
          Reconciling items — in the books, not yet on the bank
        </h3>
        {reconcilingItems.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            Nothing. Every ledger movement in this window has been cleared against a statement line.
          </p>
        ) : (
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">
              Ledger movements not cleared into this session, oldest first
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Description
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Reference
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {reconcilingItems.map((item) => (
                <ReconcilingItemRow key={item.journalId} item={item} />
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-text-subtle">
          These sum to the uncleared amount,{' '}
          <span className="font-mono tabular-nums">
            {formatMinorUnits(balances.unclearedAmount)}
          </span>{' '}
          — the cleared balance plus these items is the book balance.
        </p>
      </section>

      <section aria-label="Uncleared statement lines" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-text">
          Uncleared statement lines — on the bank, not yet in the books
        </h3>
        {unclearedStatementLines.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            Nothing. Every statement line in this window has been matched into the books.
          </p>
        ) : (
          <table className="w-full border-collapse text-base">
            <caption className="sr-only">
              Statement lines the books have not caught, oldest first
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-sm text-text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Date
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Description
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Reference
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {unclearedStatementLines.map((line) => (
                <UnclearedStatementLineRow key={line.lineId} line={line} />
              ))}
            </tbody>
          </table>
        )}
        <p className="text-xs text-text-subtle">
          Shown so the backlog is visible, but outside the uncleared amount above: a statement line
          has no journal, so it moves neither balance until it is matched.
        </p>
      </section>
    </div>
  );
}

function ReconcilingItemRow({ item }: { readonly item: ReconcilingItem }): ReactElement {
  return (
    <tr className="border-b border-border align-top">
      <td className="py-2 pr-3 font-mono text-sm text-text-muted">{item.date}</td>
      <td className="py-2 pr-3 text-text">{item.description ?? '—'}</td>
      <td className="py-2 pr-3 text-sm text-text-muted">{item.reference ?? '—'}</td>
      <td className="py-2 text-right">
        <SignedAmount value={item.amount} />
      </td>
    </tr>
  );
}

function UnclearedStatementLineRow({
  line,
}: {
  readonly line: UnclearedStatementLine;
}): ReactElement {
  return (
    <tr className="border-b border-border align-top">
      <td className="py-2 pr-3 font-mono text-sm text-text-muted">{line.date}</td>
      <td className="py-2 pr-3 text-text">{line.description}</td>
      <td className="py-2 pr-3 text-sm text-text-muted">{line.reference ?? '—'}</td>
      <td className="py-2 text-right">
        <SignedAmount value={line.amount} />
      </td>
    </tr>
  );
}
