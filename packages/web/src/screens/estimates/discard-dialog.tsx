import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { EstimateReferenceData, EstimateSummary } from './queries';
import { useDiscardEstimate, useIntentKey } from './queries';

/**
 * Discarding a draft outright — `recurring-invoices/deactivate-dialog.tsx`'s shape: a
 * plain confirmation, because `discardEstimate` itself is a plain removal (draft only, no
 * number ever allocated) rather than a refusal this dialog needs to branch on.
 *
 * Draft only, and the server is what actually enforces it (`discardEstimate` throws
 * `estimate_approved` — via `assertDraft` — the moment a number exists); this dialog is
 * only ever opened from `list.tsx`'s own draft-gated action.
 */
export interface DiscardEstimateDialogProps {
  readonly estimate: EstimateSummary | null;
  readonly reference: EstimateReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function DiscardEstimateDialog({
  estimate,
  reference,
  onOpenChange,
}: DiscardEstimateDialogProps): ReactElement {
  return (
    <Dialog open={estimate !== null} onOpenChange={onOpenChange}>
      {estimate !== null && (
        <DiscardEstimateContent
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

function DiscardEstimateContent({
  estimate,
  reference,
  onDone,
}: {
  readonly estimate: EstimateSummary;
  readonly reference: EstimateReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const discard = useDiscardEstimate();
  const intentKey = useIntentKey();

  const customerName =
    reference.contactsById.get(estimate.contactId)?.displayName ?? 'this customer';

  return (
    <DialogContent
      title="Discard this estimate?"
      description="It never carried a number and posts no journal, so there is nothing to reverse — the draft is simply removed."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={discard.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={discard.isPending}
            onClick={() => {
              discard.mutate(
                {
                  estimateId: estimate.id,
                  idempotencyKey: intentKey(`discard:${estimate.id}`),
                },
                { onSuccess: onDone },
              );
            }}
          >
            {discard.isPending ? 'Discarding…' : 'Discard'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-base text-text-muted">
        <p>
          The draft estimate for <strong className="font-medium text-text">{customerName}</strong>{' '}
          will be removed. This cannot be undone from here.
        </p>
        {discard.isError && <ErrorBanner error={discard.error} />}
      </div>
    </DialogContent>
  );
}
