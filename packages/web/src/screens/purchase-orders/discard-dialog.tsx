import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { PurchaseOrderReferenceData, PurchaseOrderSummary } from './queries';
import { useDiscardPurchaseOrder, useIntentKey } from './queries';

/**
 * Discarding a draft outright — the AP-side mirror of `estimates/discard-dialog.tsx`: a plain
 * confirmation, because `discardPurchaseOrder` itself is a plain removal (draft only, no number
 * ever allocated) rather than a refusal this dialog needs to branch on.
 *
 * Draft only, and the server is what actually enforces it (`discardPurchaseOrder` throws
 * `purchase_order_approved` the moment a number exists); this dialog is only ever opened from
 * `list.tsx`'s own draft-gated action.
 */
export interface DiscardOrderDialogProps {
  readonly order: PurchaseOrderSummary | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function DiscardOrderDialog({
  order,
  reference,
  onOpenChange,
}: DiscardOrderDialogProps): ReactElement {
  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      {order !== null && (
        <DiscardOrderContent
          key={order.id}
          order={order}
          reference={reference}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function DiscardOrderContent({
  order,
  reference,
  onDone,
}: {
  readonly order: PurchaseOrderSummary;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const discard = useDiscardPurchaseOrder();
  const intentKey = useIntentKey();

  const vendorName = reference.vendorsById.get(order.contactId)?.displayName ?? 'this vendor';

  return (
    <DialogContent
      title="Discard this purchase order?"
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
                  purchaseOrderId: order.id,
                  idempotencyKey: intentKey(`discard:${order.id}`),
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
          The draft purchase order to{' '}
          <strong className="font-medium text-text">{vendorName}</strong> will be removed. This
          cannot be undone from here.
        </p>
        {discard.isError && <ErrorBanner error={discard.error} />}
      </div>
    </DialogContent>
  );
}
