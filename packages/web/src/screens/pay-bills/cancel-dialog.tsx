import type { ReactElement } from 'react';

import { Button, Dialog, DialogClose, DialogContent, ErrorBanner } from '../../components';
import { useCancelPendingPayment, useIntentKey } from './queries';
import type { PendingPayment } from './queries';

/**
 * Cancelling an open pending payment (D-64, D-68). No ledger correction, because none was
 * ever posted — a pending payment is pencil, and this frees every bill it named back to
 * `availableToPay` on the Pay Bills window. A plain confirmation, not a branched refusal
 * surface: `cancelPendingPayment` is refused only once the payment is no longer `open`, and
 * this dialog is reached exclusively from a row that is.
 */
export interface CancelDialogProps {
  readonly payment: PendingPayment | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function CancelDialog({ payment, onOpenChange }: CancelDialogProps): ReactElement {
  return (
    <Dialog open={payment !== null} onOpenChange={onOpenChange}>
      {payment !== null && (
        <CancelDialogContent
          key={payment.id}
          payment={payment}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function CancelDialogContent({
  payment,
  onDone,
}: {
  readonly payment: PendingPayment;
  readonly onDone: () => void;
}): ReactElement {
  const cancel = useCancelPendingPayment();
  const intentKey = useIntentKey();

  return (
    <DialogContent
      title="Cancel this pending payment?"
      description={`The ${payment.vendorName} bills it named go back to available on the Pay Bills window. Nothing was ever disbursed, so there is nothing to reverse.`}
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={cancel.isPending}>Keep it</Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={cancel.isPending}
            onClick={() => {
              cancel.mutate(
                { pendingPaymentId: payment.id, idempotencyKey: intentKey(`cancel:${payment.id}`) },
                { onSuccess: onDone },
              );
            }}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel payment'}
          </Button>
        </>
      }
    >
      {cancel.isError && <ErrorBanner error={cancel.error} />}
    </DialogContent>
  );
}
