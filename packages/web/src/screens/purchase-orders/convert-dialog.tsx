import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import type { Bill, PurchaseOrderReferenceData, PurchaseOrderSummary } from './queries';
import { useConvertPurchaseOrderToBill, useIntentKey } from './queries';

/**
 * Converting an approved purchase order into a draft bill (D-M4) — the AP mirror of
 * `estimates/convert-dialog.tsx`. Convert-once: the server's row-locked read and
 * `convertedBillId IS NULL` check is what actually enforces that
 * (`purchase_order_already_converted` on a second attempt); this dialog only avoids offering
 * the action a second time (the detail view's status gate).
 *
 * The bill this produces carries every line across but is dated the day of conversion, not the
 * purchase order's own `issueDate` — a PO can sit approved for a while, and the bill it becomes
 * should date from when it was actually raised. Nothing here previews that bill, and the PO
 * itself still posts no journal (D-M3): the bill is what reaches the ledger, and only once it
 * is itself approved on the Purchases screen. `onConverted` hands the caller the bill the
 * server actually created.
 */
export interface ConvertOrderDialogProps {
  readonly order: PurchaseOrderSummary | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConverted: (bill: Bill) => void;
}

export function ConvertOrderDialog({
  order,
  reference,
  onOpenChange,
  onConverted,
}: ConvertOrderDialogProps): ReactElement {
  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      {order !== null && (
        <ConvertOrderContent
          key={order.id}
          order={order}
          reference={reference}
          onDone={(bill) => {
            onOpenChange(false);
            onConverted(bill);
          }}
        />
      )}
    </Dialog>
  );
}

function ConvertOrderContent({
  order,
  reference,
  onDone,
}: {
  readonly order: PurchaseOrderSummary;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: (bill: Bill) => void;
}): ReactElement {
  const convert = useConvertPurchaseOrderToBill();
  const intentKey = useIntentKey();

  const vendorName = reference.vendorsById.get(order.contactId)?.displayName ?? 'this vendor';

  return (
    <DialogContent
      title="Convert this purchase order to a bill?"
      description="Every line carries across to a new draft bill, dated today. This purchase order posts no journal itself — the bill is what reaches the ledger, once it is approved on the Purchases screen in turn."
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
                  purchaseOrderId: order.id,
                  idempotencyKey: intentKey(`convert:${order.id}`),
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
          The purchase order for <strong className="font-medium text-text">{vendorName}</strong>{' '}
          will produce a draft bill with the same lines. Converting happens at most once.
        </p>
        {convert.isError && <ErrorBanner error={convert.error} />}
      </div>
    </DialogContent>
  );
}
