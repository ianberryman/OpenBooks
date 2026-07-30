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
import type { EstimateReferenceData, EstimateSummary } from './queries';
import { useIntentKey, useSendEstimate } from './queries';

/**
 * Sending an approved estimate to its customer — D-M5's lean send: an HTML summary email
 * and an append-only delivery record, no hosted page and no PDF (`packages/server/src/
 * modules/predocument-delivery/send.service.ts`'s file header spells out the gap). Its own
 * dialog rather than a plain button, so there is a moment to override the recipient —
 * `sales/document-view.tsx`'s own "Send to a different address" field, mirrored here for
 * an estimate rather than an invoice.
 */
export interface SendEstimateDialogProps {
  readonly estimate: EstimateSummary | null;
  readonly reference: EstimateReferenceData;
  readonly onOpenChange: (open: boolean) => void;
}

export function SendEstimateDialog({
  estimate,
  reference,
  onOpenChange,
}: SendEstimateDialogProps): ReactElement {
  return (
    <Dialog open={estimate !== null} onOpenChange={onOpenChange}>
      {estimate !== null && (
        <SendEstimateContent
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

function SendEstimateContent({
  estimate,
  reference,
  onDone,
}: {
  readonly estimate: EstimateSummary;
  readonly reference: EstimateReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const [recipientOverride, setRecipientOverride] = useState('');

  const send = useSendEstimate();
  const intentKey = useIntentKey();

  const customerEmail = reference.contactsById.get(estimate.contactId)?.email ?? null;

  function submit(): void {
    const trimmed = recipientOverride.trim();
    const request = {
      estimateId: estimate.id,
      // '' means "no override" — the customer's own email on file — and must not become
      // `recipientEmail: ''` on the wire.
      recipientEmail: trimmed === '' ? null : trimmed,
    };
    send.mutate(
      { ...request, idempotencyKey: intentKey(`send:${estimate.id}:${JSON.stringify(request)}`) },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title="Send this estimate?"
      description="An email summary goes out to the customer. There is no hosted page or PDF in this cut — see the delivery record for whether the provider took it."
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

        <Field hint="Leave blank to send to the customer’s own email on file.">
          <FieldLabel>Send to a different address</FieldLabel>
          <TextInput
            type="email"
            value={recipientOverride}
            disabled={send.isPending}
            placeholder={customerEmail ?? 'Customer email'}
            onChange={(event) => {
              setRecipientOverride(event.target.value);
            }}
          />
        </Field>
      </div>
    </DialogContent>
  );
}
