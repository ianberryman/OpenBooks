import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { PurchaseOrderReferenceData, PurchaseOrderSummary } from './queries';
import { useApprovePurchaseOrder, useIntentKey } from './queries';

/**
 * Approving a draft — the AP-side mirror of `estimates/approve-dialog.tsx`, for an action that
 * is irreversible in the same sense: `approvePurchaseOrder` allocates a gapless number and
 * stamps `approvedAt` once (`purchase_order_already_approved` on a second attempt), the same
 * one-way door the editor's own inline Approve confirms before it commits to.
 *
 * No journal posts here at all (D-M3) — approval only allocates the number; the ledger is told
 * only once the *converted* bill is itself approved. So there is no control account to resolve
 * and no balance to check, only the server's own `ValidationError` (which `ErrorBanner` presents
 * rather than this dialog anticipating it).
 */
export interface ApproveOrderDialogProps {
  readonly order: PurchaseOrderSummary | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function ApproveOrderDialog({
  order,
  reference,
  onOpenChange,
}: ApproveOrderDialogProps): ReactElement {
  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      {order !== null && (
        <ApproveOrderContent
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

function ApproveOrderContent({
  order,
  reference,
  onDone,
}: {
  readonly order: PurchaseOrderSummary;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const approve = useApprovePurchaseOrder();
  const intentKey = useIntentKey();

  const vendorName = reference.vendorsById.get(order.contactId)?.displayName ?? 'this vendor';

  return (
    <DialogContent
      title="Approve this purchase order?"
      description="Allocates its gapless number. There is no path back to draft from here — discard and re-issue is the correction, exactly as it is for any other approved document."
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
                  purchaseOrderId: order.id,
                  idempotencyKey: intentKey(`approve:${order.id}`),
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
          The purchase order to <strong className="font-medium text-text">{vendorName}</strong> will
          be numbered and ready to send or convert to a bill.
        </p>
        {approve.isError && <ErrorBanner error={approve.error} />}
      </div>
    </DialogContent>
  );
}
