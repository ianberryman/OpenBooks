import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  Select,
} from '../components';
import { ExpenseFormDialog } from './expenses/expense-form';
import { ExpenseList } from './expenses/list';
import {
  expenseIntentKey,
  releaseExpenseIntentKey,
  useApproveExpense,
  useDiscardExpense,
  useExpenseList,
  useExpenseReferenceData,
} from './expenses/queries';
import type { BillSummary, ExpenseStatus } from './expenses/queries';

/**
 * Employee expenses (D-M1, D-M2): an expense **is** a bill whose contact carries
 * `isEmployee`, entered and approved here and reimbursed by Pay Bills settling that same
 * document — there is no separate reimbursement request, and no expense-specific void.
 *
 * ## Why this is not another tab on `purchases.tsx`
 *
 * `/v1/expenses` is its own set of routes with its own request schemas
 * (`CreateExpenseRequest`, not `CreateBillRequest`), scoped server-side to employee
 * contacts rather than vendor contacts, and this screen mirrors that split: its own
 * employee picker (`expenses/queries.ts`'s `useExpenseReferenceData`), its own simpler
 * line editor with no tax rate (`expense-state.ts`'s own commentary on why), and no vendor
 * credit, allocation or void UI at all — those remain `purchases.tsx`'s concern for the
 * one correction this screen explicitly defers to it.
 *
 * ## What a row action does, and does not, do
 *
 * Approve and Discard act directly from the list (`list.tsx`), each carrying one
 * idempotency key per `(operation, expenseId)` (`expenseIntentKey`) so a double click is
 * one intent rather than two journals. Approve is confirmed first — it is D-38's
 * irreversible step, posting a balanced journal and turning the draft into a payable —
 * and once it lands the row's status pill carries its own hint that reimbursement now
 * happens in Pay Bills (`vocabulary.ts`'s `payableHint`), so nobody goes looking here for
 * an action that lives elsewhere.
 */
type StatusFilter = 'draft' | 'approved' | 'part_paid' | 'paid' | 'void' | 'all';

const FILTER_OPTIONS: { readonly value: StatusFilter; readonly label: string }[] = [
  { value: 'all', label: 'Any status' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'part_paid', label: 'Part paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'void', label: 'Void' },
];

const EXPENSE_STATUSES: readonly ExpenseStatus[] = [
  'draft',
  'approved',
  'part_paid',
  'paid',
  'void',
];

function toStatusFilter(value: string): StatusFilter {
  return value === 'all' || (EXPENSE_STATUSES as readonly string[]).includes(value)
    ? (value as StatusFilter)
    : 'all';
}

function toQueryStatus(filter: StatusFilter): ExpenseStatus | null {
  return filter === 'all' ? null : filter;
}

export function ExpensesScreen(): ReactElement {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [approving, setApproving] = useState<BillSummary | null>(null);
  const [discarding, setDiscarding] = useState<BillSummary | null>(null);
  const [rowError, setRowError] = useState<unknown>(null);

  const reference = useExpenseReferenceData();
  const list = useExpenseList(toQueryStatus(filter));
  const approve = useApproveExpense();
  const discard = useDiscardExpense();

  const expenses = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  const busyId =
    approve.isPending && approving !== null
      ? approving.id
      : discard.isPending && discarding !== null
        ? discarding.id
        : null;

  function openCreate(): void {
    setEditingId(null);
    setFormOpen(true);
  }

  function openEdit(expense: BillSummary): void {
    setEditingId(expense.id);
    setFormOpen(true);
  }

  async function confirmApprove(): Promise<void> {
    if (approving === null) return;
    setRowError(null);
    try {
      await approve.mutateAsync({
        expenseId: approving.id,
        idempotencyKey: expenseIntentKey('approve', approving.id),
      });
      releaseExpenseIntentKey('approve', approving.id);
      setApproving(null);
    } catch (error) {
      setRowError(error);
    }
  }

  async function confirmDiscard(): Promise<void> {
    if (discarding === null) return;
    setRowError(null);
    try {
      await discard.mutateAsync({
        expenseId: discarding.id,
        idempotencyKey: expenseIntentKey('discard', discarding.id),
      });
      releaseExpenseIntentKey('discard', discarding.id);
      releaseExpenseIntentKey('approve', discarding.id);
      setDiscarding(null);
    } catch (error) {
      setRowError(error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-text">Employee expenses</h1>
          <p className="max-w-form text-text-muted">
            A bill against an employee contact. Approving one posts its journal and makes it payable
            — reimbursement happens in Pay Bills, settling this same document.
          </p>
        </div>
        <Button variant="primary" disabled={reference.data === null} onClick={openCreate}>
          New expense
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface p-3">
        <Field className="w-48">
          <FieldLabel>Status</FieldLabel>
          <Select
            value={filter}
            options={FILTER_OPTIONS}
            onValueChange={(value) => {
              setFilter(toStatusFilter(value));
            }}
          />
        </Field>
      </div>

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {rowError !== null && <ErrorBanner error={rowError} onRetry={() => setRowError(null)} />}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading employees and accounts…</p>
      ) : (
        <>
          <ExpenseList
            expenses={expenses}
            reference={reference.data}
            loading={list.isPending}
            emptyMessage={
              filter === 'all'
                ? 'No employee expenses yet. A new one starts as a draft and reaches the ' +
                  'ledger only when it is approved.'
                : 'No expenses match this filter.'
            }
            busyId={busyId}
            onEdit={openEdit}
            onApprove={(expense) => {
              setRowError(null);
              setApproving(expense);
            }}
            onDiscard={(expense) => {
              setRowError(null);
              setDiscarding(expense);
            }}
          />

          {list.hasNextPage && (
            <div>
              <Button
                disabled={list.isFetchingNextPage}
                onClick={() => {
                  void list.fetchNextPage();
                }}
              >
                {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}

          <ExpenseFormDialog
            expenseId={editingId}
            reference={reference.data}
            open={formOpen}
            onOpenChange={(open) => {
              setFormOpen(open);
              if (!open) setEditingId(null);
            }}
          />

          <Dialog
            open={approving !== null}
            onOpenChange={(open) => {
              if (!open) setApproving(null);
            }}
          >
            <DialogContent
              title={`Approve ${approving?.documentNumber ?? 'this expense'}?`}
              description="Posts a balanced journal and turns this draft into a payable. This cannot be undone — the correction afterward is a bill void, not an edit."
              footer={
                <>
                  <Button onClick={() => setApproving(null)}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={approve.isPending}
                    onClick={() => {
                      void confirmApprove();
                    }}
                  >
                    {approve.isPending ? 'Approving…' : 'Approve expense'}
                  </Button>
                </>
              }
            >
              <p className="text-sm text-text-muted">
                Once approved, this expense becomes payable to the employee. Reimburse it from Pay
                Bills — there is no reimbursement action on this screen.
              </p>
            </DialogContent>
          </Dialog>

          <Dialog
            open={discarding !== null}
            onOpenChange={(open) => {
              if (!open) setDiscarding(null);
            }}
          >
            <DialogContent
              title={`Discard ${discarding?.documentNumber ?? 'this draft'}?`}
              description="The draft and its lines are deleted. Nothing in the ledger changes, and no number is left unused — an expense is numbered at approval, never before."
              footer={
                <>
                  <Button onClick={() => setDiscarding(null)}>Keep editing</Button>
                  <Button
                    variant="danger"
                    disabled={discard.isPending}
                    onClick={() => {
                      void confirmDiscard();
                    }}
                  >
                    {discard.isPending ? 'Discarding…' : 'Discard expense'}
                  </Button>
                </>
              }
            >
              <p className="text-sm text-text-muted">
                This cannot be undone, and it does not need to be: nothing about this draft has
                reached the ledger.
              </p>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
