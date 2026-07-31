import type { ReactElement } from 'react';

import { Button, Pill, ResponsiveTable, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { EstimateReferenceData, EstimateSummary } from './queries';
import { STATUS_LABELS, STATUS_PILL_TONE } from './vocabulary';

/**
 * One page of estimates — `fixed-assets/list.tsx`'s shape. `status` is read off the
 * response, never derived (D-M6): approving and converting are the only two writes that
 * ever move it, and both are this screen's own actions, so the table simply shows what the
 * server last said.
 */
export interface EstimateListProps {
  readonly estimates: readonly EstimateSummary[];
  readonly reference: EstimateReferenceData;
  readonly loading: boolean;
  readonly emptyMessage: string;
  readonly onEdit: (estimate: EstimateSummary) => void;
  readonly onApprove: (estimate: EstimateSummary) => void;
  readonly onConvert: (estimate: EstimateSummary) => void;
  readonly onSend: (estimate: EstimateSummary) => void;
  readonly onDiscard: (estimate: EstimateSummary) => void;
}

export function EstimateList({
  estimates,
  reference,
  loading,
  emptyMessage,
  onEdit,
  onApprove,
  onConvert,
  onSend,
  onDiscard,
}: EstimateListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Estimates</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Number
            </th>
            <th scope="col" className={TH_CLASSES}>
              Customer
            </th>
            <th scope="col" className={TH_CLASSES}>
              Status
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              Total
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {estimates.length === 0 && (
            <EmptyRow columns={5}>{loading ? 'Loading…' : emptyMessage}</EmptyRow>
          )}
          {estimates.map((estimate) => {
            const canEdit = estimate.status === 'draft';
            const canApprove = estimate.status === 'draft';
            const canConvert =
              estimate.status === 'approved' && estimate.convertedInvoiceId === null;
            // Sending is refused only while a draft holds no number to send (`sendEstimate`'s
            // own `${kind}_not_approved`) — it stays offered after conversion, because the
            // estimate itself still exists and can still be emailed.
            const canSend = estimate.status !== 'draft';
            const canDiscard = estimate.status === 'draft';
            const customerName =
              reference.contactsById.get(estimate.contactId)?.displayName ?? 'Unknown customer';

            return (
              <tr key={estimate.id}>
                <td className={TD_CLASSES}>
                  <span className="font-mono">{estimate.documentNumber ?? '—'}</span>
                  {estimate.reference !== null && estimate.reference !== '' && (
                    <span className="block text-xs text-text-subtle">{estimate.reference}</span>
                  )}
                </td>
                <td className={TD_CLASSES}>{customerName}</td>
                <td className={TD_CLASSES}>
                  <Pill tone={STATUS_PILL_TONE[estimate.status]}>
                    {STATUS_LABELS[estimate.status]}
                  </Pill>
                </td>
                <td className={cx(TD_CLASSES, 'text-right font-mono tabular-nums')}>
                  {formatMoney(estimate.totals.gross)}
                </td>
                <td className={cx(TD_CLASSES, 'text-right')}>
                  <div className="flex justify-end gap-1">
                    {canEdit && (
                      <Button
                        size="sm"
                        onClick={() => {
                          onEdit(estimate);
                        }}
                      >
                        Edit
                      </Button>
                    )}
                    {canApprove && (
                      <Button
                        size="sm"
                        onClick={() => {
                          onApprove(estimate);
                        }}
                      >
                        Approve
                      </Button>
                    )}
                    {canConvert && (
                      <Button
                        size="sm"
                        onClick={() => {
                          onConvert(estimate);
                        }}
                      >
                        Convert to invoice
                      </Button>
                    )}
                    {canSend && (
                      <Button
                        size="sm"
                        onClick={() => {
                          onSend(estimate);
                        }}
                      >
                        Send
                      </Button>
                    )}
                    {canDiscard && (
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Discard estimate for ${customerName}`}
                        onClick={() => {
                          onDiscard(estimate);
                        }}
                      >
                        Discard
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
