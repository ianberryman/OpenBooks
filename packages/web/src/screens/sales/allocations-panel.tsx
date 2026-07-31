import type { ReactElement } from 'react';

import { Button, ResponsiveTable, formatMinorUnits } from '../../components';
import type { Allocation, SalesDocumentKind } from './queries';

/**
 * What has been applied to or from this document, and the button that takes one off
 * again.
 *
 * ## Why the un-apply button is here rather than only in a payments screen
 *
 * It is the recovery for `document_has_allocations` — voiding a document with allocations
 * against it is refused, and the refusal says to remove them first. A refusal whose fix
 * lives on a screen the user has to go and find is a refusal they read as a dead end, so
 * the rows the void was refused over are listed on the document itself with the operation
 * that clears them.
 *
 * Removing one is a delete and not a reversal, and that is consistent with D-16 rather
 * than an exception to it: an allocation posted no journal, so removing it restates no
 * financial statement. What it changes is what is outstanding, and that is computed on
 * read (D-34) — there is no stored balance anywhere that would need correcting.
 */
export interface AllocationsPanelProps {
  readonly allocations: readonly Allocation[];
  readonly kind: SalesDocumentKind;
  readonly disabled: boolean;
  readonly onRemove: (allocation: Allocation) => void;
}

const SOURCE_LABELS: Readonly<Record<Allocation['sourceType'], string>> = {
  payment: 'Payment',
  credit_note: 'Credit note',
  vendor_credit: 'Vendor credit',
  // Cash application (D-106): an early-pay discount settling this document.
  discount: 'Early-pay discount',
};

export function AllocationsPanel({
  allocations,
  kind,
  disabled,
  onRemove,
}: AllocationsPanelProps): ReactElement {
  if (allocations.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {kind === 'invoice'
          ? 'Nothing has been applied to this invoice yet.'
          : 'This credit has not been applied to any invoice yet. Approving it made the credit ' +
            'available; applying it is a separate act.'}
      </p>
    );
  }

  return (
    <ResponsiveTable>
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Allocations against this document</caption>
        <thead>
          <tr className="text-left text-xs text-text-subtle">
            <th scope="col" className="p-1 font-medium">
              {kind === 'invoice' ? 'Applied from' : 'Applied to'}
            </th>
            <th scope="col" className="p-1 font-medium">
              Date
            </th>
            <th scope="col" className="p-1 text-right font-medium">
              Amount
            </th>
            <th scope="col" className="p-1 font-medium">
              <span className="sr-only">Un-apply</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {allocations.map((allocation) => {
            /**
             * On an invoice the interesting end is the source — what paid it. On a credit
             * note it is the target — which invoice the credit went against. The same shape
             * carries both ends precisely so one component can read either (`allocationSchema`).
             */
            const farNumber =
              kind === 'invoice'
                ? (allocation.sourceNumber ?? SOURCE_LABELS[allocation.sourceType])
                : (allocation.targetNumber ?? 'Invoice');
            const farKind = kind === 'invoice' ? SOURCE_LABELS[allocation.sourceType] : 'Invoice';

            return (
              <tr key={allocation.id} className="border-t border-border">
                <td className="p-1 text-text">
                  <span className="text-text-muted">{farKind}</span>{' '}
                  <span className="font-mono">{farNumber}</span>
                </td>
                <td className="p-1 font-mono text-text-muted">{allocation.date}</td>
                <td className="p-1 text-right font-mono tabular-nums text-text">
                  {formatMinorUnits(allocation.amount)}
                </td>
                <td className="p-1 text-right">
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => {
                      onRemove(allocation);
                    }}
                  >
                    Un-apply
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
