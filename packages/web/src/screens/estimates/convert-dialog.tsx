import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { EstimateReferenceData, EstimateSummary, Invoice } from './queries';
import { useConvertEstimateToInvoice, useIntentKey } from './queries';

/**
 * Converting an approved estimate into a draft invoice (D-M4) — the one form of customer
 * acceptance this v1 models (`Estimate.status`'s own words: "converting it *is* accepting
 * it"). Convert-once: the server's row-locked read and `convertedInvoiceId IS NULL` check
 * is what actually enforces that (`estimate_already_converted` on a second attempt); this
 * dialog only avoids offering the action a second time (`list.tsx`'s status gate).
 *
 * The invoice this produces carries every line across but is dated the day of conversion,
 * not the estimate's own `issueDate` — an estimate can sit approved for months, and the
 * invoice it becomes should date from when it was actually raised (`estimates.service.ts`'s
 * file header). Nothing here previews that invoice; `onConverted` hands the caller the one
 * the server actually created.
 */
export interface ConvertEstimateDialogProps {
  readonly estimate: EstimateSummary | null;
  readonly reference: EstimateReferenceData;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConverted: (invoice: Invoice) => void;
}

export function ConvertEstimateDialog({
  estimate,
  reference,
  onOpenChange,
  onConverted,
}: ConvertEstimateDialogProps): ReactElement {
  return (
    <Dialog open={estimate !== null} onOpenChange={onOpenChange}>
      {estimate !== null && (
        <ConvertEstimateContent
          key={estimate.id}
          estimate={estimate}
          reference={reference}
          onDone={(invoice) => {
            onOpenChange(false);
            onConverted(invoice);
          }}
        />
      )}
    </Dialog>
  );
}

function ConvertEstimateContent({
  estimate,
  reference,
  onDone,
}: {
  readonly estimate: EstimateSummary;
  readonly reference: EstimateReferenceData;
  readonly onDone: (invoice: Invoice) => void;
}): ReactElement {
  const convert = useConvertEstimateToInvoice();
  const intentKey = useIntentKey();

  const customerName =
    reference.contactsById.get(estimate.contactId)?.displayName ?? 'this customer';

  return (
    <DialogContent
      title="Convert this estimate to an invoice?"
      description="Every line carries across to a new draft invoice, dated today. This estimate posts no journal itself — the invoice is what reaches the ledger, once it is approved in turn."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={convert.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={convert.isPending}
            onClick={() => {
              convert.mutate(
                {
                  estimateId: estimate.id,
                  idempotencyKey: intentKey(`convert:${estimate.id}`),
                },
                { onSuccess: onDone },
              );
            }}
          >
            {convert.isPending ? 'Converting…' : 'Convert'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base text-text-muted">
        <p>
          The estimate for <strong className="font-medium text-text">{customerName}</strong> will
          produce a draft invoice with the same lines. Converting happens at most once.
        </p>
        {convert.isError && <ErrorBanner error={convert.error} />}
      </div>
    </DialogContent>
  );
}
