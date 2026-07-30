import type { ReactElement } from 'react';
import { useState } from 'react';

import { Button, ErrorBanner, Field, FieldLabel, Select } from '../components';
import { BatchIssueDialog } from './pay-bills/batch-issue-dialog';
import { CancelDialog } from './pay-bills/cancel-dialog';
import { IssueDialog } from './pay-bills/issue-dialog';
import { PendingPaymentsTable } from './pay-bills/pending-payments-table';
import type { PendingPayment, PendingPaymentStatus, Rail } from './pay-bills/queries';
import { useIntentKey, usePendingPayments, useUpdatePendingPayment } from './pay-bills/queries';

/**
 * The Disbursements queue (OB-116; ROADMAP D-64, D-65, D-68, D-109, D-110) — every pending
 * payment the Pay Bills window built, with rail routing, issue and cancel.
 *
 * ## What "issue" does that "build" did not
 *
 * Building reserves a bill's `committed` and posts nothing (D-64) — a pending payment is
 * pencil. Issuing is the moment it becomes real: `POST …/issue` posts the journal, the
 * `payAmount` allocations, any settlement discount and any applied vendor credit, all in one
 * transaction (D-65), and for `rail: 'check'` draws a real check number from the bank
 * account's register. That is why this screen, and not the Pay Bills window, is where a check
 * number appears.
 */

type StatusFilter = PendingPaymentStatus | 'all';

const STATUS_OPTIONS: readonly { readonly value: StatusFilter; readonly label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'issued', label: 'Issued' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

export function DisbursementsScreen(): ReactElement {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [issuing, setIssuing] = useState<PendingPayment | null>(null);
  const [cancelling, setCancelling] = useState<PendingPayment | null>(null);
  const [batchIssueOpen, setBatchIssueOpen] = useState(false);
  const [railPendingId, setRailPendingId] = useState<string | null>(null);

  const list = usePendingPayments(statusFilter === 'all' ? null : statusFilter);
  const updateRail = useUpdatePendingPayment();
  const intentKey = useIntentKey();

  const payments = list.data ?? [];
  const selectedPayments = payments.filter(
    (payment) => selectedIds.has(payment.id) && payment.status === 'open',
  );

  function toggleSelect(payment: PendingPayment): void {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(payment.id)) next.delete(payment.id);
      else next.add(payment.id);
      return next;
    });
  }

  function changeRail(payment: PendingPayment, rail: Rail): void {
    setRailPendingId(payment.id);
    updateRail.mutate(
      {
        pendingPaymentId: payment.id,
        patch: { rail },
        idempotencyKey: intentKey(`rail:${payment.id}:${rail}`),
      },
      { onSettled: () => setRailPendingId(null) },
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Disbursements</h1>
          <p className="max-w-form text-text-muted">
            What the Pay Bills window built — pending until issued. Issuing materialises a real
            Payment and, for a check, draws its number from the bank account's register.
          </p>
        </div>
        <Field className="w-44">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={statusFilter}
            options={STATUS_OPTIONS}
            onValueChange={(value) => {
              setStatusFilter(value as StatusFilter);
              setSelectedIds(new Set());
            }}
          />
        </Field>
      </div>

      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {updateRail.isError && <ErrorBanner error={updateRail.error} />}

      {selectedPayments.length > 0 && (
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={() => {
              setBatchIssueOpen(true);
            }}
          >
            Issue {selectedPayments.length} selected
          </Button>
        </div>
      )}

      <PendingPaymentsTable
        payments={payments}
        loading={list.isPending}
        selectedIds={selectedIds}
        railPendingId={railPendingId}
        disabled={false}
        onToggleSelect={toggleSelect}
        onChangeRail={changeRail}
        onIssue={setIssuing}
        onCancel={setCancelling}
      />

      <IssueDialog
        payment={issuing}
        onOpenChange={(open) => {
          if (!open) setIssuing(null);
        }}
      />

      <CancelDialog
        payment={cancelling}
        onOpenChange={(open) => {
          if (!open) setCancelling(null);
        }}
      />

      <BatchIssueDialog
        payments={selectedPayments}
        open={batchIssueOpen}
        onOpenChange={(open) => {
          setBatchIssueOpen(open);
          if (!open) setSelectedIds(new Set());
        }}
      />
    </div>
  );
}
