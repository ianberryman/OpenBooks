import type { ReactElement } from 'react';
import { useId, useState } from 'react';

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
import { todayCalendarDate } from './amounts';
import type { IssueOutcome, PendingPayment } from './queries';
import { useIntentKey, useIssuePendingPayment } from './queries';

/**
 * Issuing one pending payment (D-65, D-109, D-110).
 *
 * `issuePendingPayment` **resolves** with `IssueOutcome` on a rail failure — `status:
 * 'failed'` is a normal, non-throwing answer (a bad ACH detail, an inactive bank account) —
 * so this dialog does not read `.isError` to decide what to show; it reads the outcome's own
 * `status`. `.isError` still covers the transport/refusal cases `unwrap` throws on: a 404 for
 * a payment that no longer exists, a permission failure, an already-issued payment.
 */
export interface IssueDialogProps {
  readonly payment: PendingPayment | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function IssueDialog({ payment, onOpenChange }: IssueDialogProps): ReactElement {
  return (
    <Dialog open={payment !== null} onOpenChange={onOpenChange}>
      {payment !== null && (
        <IssueDialogContent key={payment.id} payment={payment} onOpenChange={onOpenChange} />
      )}
    </Dialog>
  );
}

function IssueDialogContent({
  payment,
  onOpenChange,
}: {
  readonly payment: PendingPayment;
  readonly onOpenChange: (open: boolean) => void;
}): ReactElement {
  const formId = useId();
  const [date, setDate] = useState(() => todayCalendarDate());
  const [reference, setReference] = useState('');
  const [outcome, setOutcome] = useState<IssueOutcome | null>(null);

  const issue = useIssuePendingPayment();
  const intentKey = useIntentKey();
  const fieldErrors = presentApiError(issue.error).fieldErrors;

  if (outcome !== null) {
    return (
      <DialogContent
        title={outcome.status === 'issued' ? 'Payment issued' : 'The payment was not issued'}
        footer={
          outcome.status === 'issued' ? (
            <Button
              variant="primary"
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <DialogClose asChild>
                <Button>Close</Button>
              </DialogClose>
              <Button
                variant="primary"
                onClick={() => {
                  setOutcome(null);
                }}
              >
                Try again
              </Button>
            </>
          )
        }
      >
        {outcome.status === 'issued' ? (
          <p className="text-text-muted">
            {payment.vendorName} —{' '}
            {outcome.checkNumber !== null ? (
              <>
                check number{' '}
                <span className="font-mono font-semibold text-text">{outcome.checkNumber}</span>
              </>
            ) : (
              'the disbursement was handed off to the rail.'
            )}
          </p>
        ) : (
          <p className="text-danger-text">
            Refused: <span className="font-mono">{outcome.error ?? 'unknown reason'}</span>
          </p>
        )}
      </DialogContent>
    );
  }

  return (
    <DialogContent
      title={`Issue the payment to ${payment.vendorName}`}
      description={`Materialises it into a real Payment for ${payment.rail === 'check' ? 'a check drawn from the register' : `an external ${payment.rail} handoff`}.`}
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
          const body = {
            date,
            ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
          };
          issue.mutate(
            {
              pendingPaymentId: payment.id,
              body,
              idempotencyKey: intentKey(`issue:${payment.id}:${JSON.stringify(body)}`),
            },
            { onSuccess: setOutcome },
          );
        }}
      >
        {issue.isError && <ErrorBanner error={issue.error} />}

        <Field error={fieldErrors['date']} hint="Must fall in an open fiscal period.">
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

        {payment.rail !== 'check' && (
          <Field
            error={fieldErrors['reference']}
            hint="The rail's own trace or confirmation, once the external system returns one. Left blank, this posts with no reference yet."
          >
            <FieldLabel>Reference</FieldLabel>
            <TextInput
              value={reference}
              autoComplete="off"
              disabled={issue.isPending}
              onChange={(event) => {
                setReference(event.target.value);
              }}
            />
          </Field>
        )}
      </form>
    </DialogContent>
  );
}
