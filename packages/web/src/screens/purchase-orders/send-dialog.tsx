import type { ReactElement } from 'react';
import { useState } from 'react';

import { presentApiError } from '../../api';
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
import type { PurchaseOrderReferenceData, PurchaseOrderSummary } from './queries';
import { useIntentKey, useSendPurchaseOrder } from './queries';

/**
 * Emailing an approved purchase order to its vendor (`sendPurchaseOrder`) —
 * `sales/document-view.tsx`'s "Send this invoice?" dialog, the AR mirror, adapted to a
 * purchase order's own recipient rule: `recipientEmail` overrides the destination for this
 * one send, and left blank the server falls back to the vendor contact's own email.
 *
 * A draft cannot be sent — there is nothing approved yet to summarise
 * (`purchase_order_not_approved`) — so `purchase-orders/list.tsx` only ever opens this from
 * an `approved` row.
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
        <SendOrderForm
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

function SendOrderForm({
  order,
  reference,
  onDone,
}: {
  readonly order: PurchaseOrderSummary;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const [recipientOverride, setRecipientOverride] = useState('');
  const [sent, setSent] = useState<string | null>(null);

  const send = useSendPurchaseOrder();
  const intentKey = useIntentKey();

  const fieldErrors = presentApiError(send.error).fieldErrors;
  const vendorName = reference.vendorsById.get(order.contactId)?.displayName ?? 'this vendor';

  function submit(): void {
    const trimmed = recipientOverride.trim();
    // `''` means "no override" on the wire and must never become `recipientEmail: ''` — a
    // real, wrong value distinct from omitting the field, `SendPredocumentRequest`'s own
    // reading of an absent override.
    const body = trimmed === '' ? {} : { recipientEmail: trimmed };
    send.mutate(
      { purchaseOrderId: order.id, request: body, idempotencyKey: intentKey(JSON.stringify(body)) },
      {
        onSuccess: (delivery) => {
          setSent(delivery.recipientEmail);
        },
      },
    );
  }

  return (
    <DialogContent
      title={`Send ${order.documentNumber ?? 'this purchase order'} to ${vendorName}?`}
      description="Emails a summary of the purchase order below to the vendor."
      footer={
        sent !== null ? (
          <DialogClose asChild>
            <Button
              variant="primary"
              onClick={() => {
                onDone();
              }}
            >
              Done
            </Button>
          </DialogClose>
        ) : (
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
        )
      }
    >
      {sent !== null ? (
        <p role="status" className="text-sm text-text">
          Sent to {sent}.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {send.isError && <ErrorBanner error={send.error} />}
          <Field
            error={fieldErrors['recipientEmail']}
            hint="Leave blank to send to the vendor's own email on file."
          >
            <FieldLabel>Send to a different address</FieldLabel>
            <TextInput
              type="email"
              value={recipientOverride}
              disabled={send.isPending}
              onChange={(event) => {
                setRecipientOverride(event.target.value);
              }}
            />
          </Field>
        </div>
      )}
    </DialogContent>
  );
}
