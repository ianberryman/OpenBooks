import type { ReactElement } from 'react';
import { useState } from 'react';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  TextInput,
} from '../../components';
import type {
  PurchaseOrderReferenceData,
  PurchaseOrderSummary,
  SendPurchaseOrderRequest,
} from './queries';
import { useIntentKey, useSendPurchaseOrder } from './queries';

/**
 * Sending an approved purchase order to its vendor — D-M5's lean send: an HTML summary email
 * and an append-only delivery record, no hosted page and no PDF. The AP mirror of
 * `estimates/send-dialog.tsx`. Its own dialog rather than a plain button, so there is a moment
 * to override the recipient — the "Send to a different address" field, mirrored here for a
 * purchase order rather than an estimate.
 *
 * A draft cannot be sent — there is nothing approved yet to summarise
 * (`purchase_order_not_approved`) — so this only ever opens from an `approved` (or already
 * `converted`) order.
 */
export interface SendOrderDialogProps {
  readonly order: PurchaseOrderSummary | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function SendOrderDialog({
  order,
  reference,
  onOpenChange,
}: SendOrderDialogProps): ReactElement {
  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      {order !== null && (
        <SendOrderContent
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

function SendOrderContent({
  order,
  reference,
  onDone,
}: {
  readonly order: PurchaseOrderSummary;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const [recipientOverride, setRecipientOverride] = useState('');

  const send = useSendPurchaseOrder();
  const intentKey = useIntentKey();

  const vendorEmail = reference.vendorsById.get(order.contactId)?.email ?? null;

  function submit(): void {
    const trimmed = recipientOverride.trim();
    // '' means "no override" — the vendor's own email on file — and must never become
    // `recipientEmail: ''` on the wire, a real, wrong value distinct from omitting the field
    // (`SendPredocumentRequest`'s own reading of an absent override).
    const request: SendPurchaseOrderRequest = trimmed === '' ? {} : { recipientEmail: trimmed };
    send.mutate(
      {
        purchaseOrderId: order.id,
        request,
        idempotencyKey: intentKey(`send:${order.id}:${JSON.stringify(request)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title="Send this purchase order?"
      description="An email summary goes out to the vendor. There is no hosted page or PDF in this cut — see the delivery record for whether the provider took it."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={send.isPending}>Cancel</Button>
          </DialogClose>
          <Button
            variant="primary"
            disabled={send.isPending}
            onClick={() => {
              submit();
            }}
          >
            {send.isPending ? 'Sending…' : 'Send'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {send.isError && <ErrorBanner error={send.error} />}

        <Field hint="Leave blank to send to the vendor’s own email on file.">
          <FieldLabel>Send to a different address</FieldLabel>
          <TextInput
            type="email"
            value={recipientOverride}
            disabled={send.isPending}
            placeholder={vendorEmail ?? 'Vendor email'}
            onChange={(event) => {
              setRecipientOverride(event.target.value);
            }}
          />
        </Field>
      </div>
    </DialogContent>
  );
}
