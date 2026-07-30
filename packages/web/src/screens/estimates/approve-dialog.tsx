import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { EstimateReferenceData, EstimateSummary } from './queries';
import { useApproveEstimate, useIntentKey } from './queries';

/**
 * Approving a draft — `recurring-invoices/deactivate-dialog.tsx`'s plain-confirmation
 * shape, for an action that is irreversible in the same sense: `approveEstimate` allocates
 * a gapless number and stamps `approvedAt` once (`estimate_already_approved` on a second
 * attempt), the same one-way door `sales/document-editor.tsx`'s own Approve confirms before
 * it commits to.
 *
 * No journal posts here at all (D-M3) — unlike an invoice's approve, there is no control
 * account to resolve and no balance to check, only that the estimate still has at least
 * one line (`approveEstimate`'s own `ValidationError` otherwise, which `ErrorBanner`
 * presents rather than this dialog anticipating it).
 */
export interface ApproveEstimateDialogProps {
  readonly estimate: EstimateSummary | null;
  readonly reference: EstimateReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function ApproveEstimateDialog({
  estimate,
  reference,
  onOpenChange,
}: ApproveEstimateDialogProps): ReactElement {
  return (
    <Dialog open={estimate !== null} onOpenChange={onOpenChange}>
      {estimate !== null && (
        <ApproveEstimateContent
          key={estimate.id}
          estimate={estimate}
          reference={reference}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function ApproveEstimateContent({
  estimate,
  reference,
  onDone,
}: {
  readonly estimate: EstimateSummary;
  readonly reference: EstimateReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const approve = useApproveEstimate();
  const intentKey = useIntentKey();

  const customerName =
    reference.contactsById.get(estimate.contactId)?.displayName ?? 'this customer';

  return (
    <DialogContent
      title="Approve this estimate?"
      description="Allocates its gapless number. There is no path back to draft from here — discard and re-quote is the correction, exactly as it is for any other approved document."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={approve.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={approve.isPending}
            onClick={() => {
              approve.mutate(
                {
                  estimateId: estimate.id,
                  idempotencyKey: intentKey(`approve:${estimate.id}`),
                },
                { onSuccess: onDone },
              );
            }}
          >
            {approve.isPending ? 'Approving…' : 'Approve'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base text-text-muted">
        <p>
          The estimate for <strong className="font-medium text-text">{customerName}</strong> will be
          numbered and ready to send or convert.
        </p>
        {approve.isError && <ErrorBanner error={approve.error} />}
      </div>
    </DialogContent>
  );
}
