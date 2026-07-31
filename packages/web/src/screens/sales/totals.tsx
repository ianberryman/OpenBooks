import type { ReactElement } from 'react';

import { formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import type { SalesDocument, SalesReferenceData } from './queries';

/**
 * The document's three totals, its tax summary, and what is left on it.
 *
 * **Every number here arrives from the server.** The totals are the sums of the rounded
 * lines rather than the rate applied to a sum (D-35), and `settlement.allocated` and
 * `settlement.outstanding` are the total minus the allocations applied, computed on read
 * and stored nowhere (D-34). Summing `allocations` here instead would be a second
 * definition of outstanding — the exact divergence spec §11's subledger-agreement
 * invariant exists to catch — so this component reads fields and formats them and does
 * nothing else.
 */
export interface TotalsPanelProps {
  readonly document: SalesDocument;
  readonly reference: SalesReferenceData;
  /** The outstanding line's name: "Still owed" or "Credit available" (D-39, one arithmetic). */
  readonly outstandingLabel: string;
  /** True while the editor holds unsaved edits, in which case these are the last saved figures. */
  readonly stale: boolean;
}

function Row({
  label,
  value,
  emphasis,
  muted,
}: {
  readonly label: string;
  readonly value: string;
  readonly emphasis?: boolean;
  readonly muted?: boolean;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <dt
        className={cx('text-sm', emphasis === true ? 'font-semibold text-text' : 'text-text-muted')}
      >
        {label}
      </dt>
      <dd
        className={cx(
          'font-mono text-sm tabular-nums',
          muted === true ? 'text-text-subtle' : 'text-text',
          emphasis === true && 'font-semibold',
        )}
      >
        {formatMoney(value)}
      </dd>
    </div>
  );
}

export function TotalsPanel({
  document,
  reference,
  outstandingLabel,
  stale,
}: TotalsPanelProps): ReactElement {
  return (
    <div className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-3">
      {stale && (
        <p role="status" className="text-xs text-text-subtle">
          These are the figures from the last save. Tax is computed and rounded per line by the
          server, so the document is repriced when it is saved — never in this browser.
        </p>
      )}

      <dl className="flex flex-col gap-1">
        <Row label="Net" value={document.totals.net} muted={stale} />
        <Row label="Tax" value={document.totals.tax} muted={stale} />
        <Row label="Total" value={document.totals.gross} emphasis muted={stale} />
      </dl>

      {document.taxSummary.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-border pt-2">
          <p className="text-xs font-medium text-text-muted">Tax summary</p>
          <dl className="flex flex-col gap-1">
            {document.taxSummary.map((row) => (
              <Row
                key={row.taxRateId ?? 'untaxed'}
                /**
                 * Grouped by rate id rather than by percentage: two rates can share a
                 * percentage and post to different accounts, and a tax return reports
                 * them separately. The name rides along on the row so a document prints
                 * as it stood rather than against today's rate list.
                 */
                label={
                  row.taxRateId === null
                    ? 'Untaxed'
                    : (row.taxRateName ?? reference.taxRatesById.get(row.taxRateId)?.name ?? 'Tax')
                }
                value={row.tax}
                muted={stale}
              />
            ))}
          </dl>
        </div>
      )}

      {document.status !== 'draft' && (
        <dl className="flex flex-col gap-1 border-t border-border pt-2">
          <Row label="Applied" value={document.settlement.allocated} />
          <Row label={outstandingLabel} value={document.settlement.outstanding} emphasis />
        </dl>
      )}
    </div>
  );
}
