import type { ReactElement } from 'react';
import { useId, useState } from 'react';

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
import { todayCalendarDate } from './amounts';
import type { IssueResult, PendingPayment } from './queries';
import { useIntentKey, useIssuePendingPayments } from './queries';

/**
 * Issuing several pending payments at once, `POST /v1/disbursements/issue` (G2/D-63).
 *
 * Atomic per payment, not per run: one bad ACH detail leaves the rest issued and reports
 * that one `failed` in the returned `IssueResult`. So — like `issue-dialog.tsx`'s single
 * form — this never treats a partial failure as `.isError`; it renders every outcome the
 * batch returned, success and failure side by side, keyed back to the vendor names the
 * caller already had.
 */
export interface BatchIssueDialogProps {
  readonly payments: readonly PendingPayment[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function BatchIssueDialog({
  payments,
  open,
  onOpenChange,
}: BatchIssueDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <BatchIssueDialogContent payments={payments} onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

function BatchIssueDialogContent({
  payments,
  onOpenChange,
}: {
  readonly payments: readonly PendingPayment[];
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const formId = useId();
  const [date, setDate] = useState(() => todayCalendarDate());
  const [result, setResult] = useState<IssueResult | null>(null);

  const issue = useIssuePendingPayments();
  const intentKey = useIntentKey();

  const vendorNameOf = (pendingPaymentId: string): string =>
    payments.find((payment) => payment.id === pendingPaymentId)?.vendorName ?? pendingPaymentId;

  if (result !== null) {
    const issuedCount = result.outcomes.filter((outcome) => outcome.status === 'issued').length;

    return (
      <DialogContent
        title={`${issuedCount} of ${result.outcomes.length} issued`}
        footer={
          <Button
            variant="primary"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            Done
          </Button>
        }
      >
        <ul className="flex flex-col gap-1" aria-label="Issue outcomes">
          {result.outcomes.map((outcome) => (
            <li key={outcome.pendingPaymentId} className="flex justify-between text-sm">
              <span className="text-text">{vendorNameOf(outcome.pendingPaymentId)}</span>
              {outcome.status === 'issued' ? (
                <span className="text-success-text">
                  Issued
                  {outcome.checkNumber !== null && (
                    <>
                      {' '}
                      · <span className="font-mono">{outcome.checkNumber}</span>
                    </>
                  )}
                </span>
              ) : (
                <span className="font-mono text-danger-text">{outcome.error ?? 'failed'}</span>
              )}
            </li>
          ))}
        </ul>
      </DialogContent>
    );
  }

  return (
    <DialogContent
      title={`Issue ${payments.length} payment${payments.length === 1 ? '' : 's'}`}
      description="One date for the whole batch. Each payment is materialised in its own transaction — one refusal does not lose the rest."
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={issue.isPending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={issue.isPending}>
            {issue.isPending ? 'Issuing…' : 'Issue'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const pendingPaymentIds = payments.map((payment) => payment.id);
          issue.mutate(
            {
              pendingPaymentIds,
              date,
              idempotencyKey: intentKey(`issue-batch:${date}:${pendingPaymentIds.join(',')}`),
            },
            { onSuccess: setResult },
          );
        }}
      >
        {issue.isError && <ErrorBanner error={issue.error} />}

        <Field hint="Must fall in an open fiscal period.">
          <FieldLabel>Date</FieldLabel>
          <TextInput
            type="date"
            value={date}
            disabled={issue.isPending}
            onChange={(event) => {
              setDate(event.target.value);
            }}
          />
        </Field>

        <ul
          className="flex flex-col gap-0.5 text-sm text-text-muted"
          aria-label="Payments to issue"
        >
          {payments.map((payment) => (
            <li key={payment.id}>{payment.vendorName}</li>
          ))}
        </ul>
      </form>
    </DialogContent>
  );
}
