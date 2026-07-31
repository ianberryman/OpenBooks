import type { ReactElement } from 'react';
import { useId, useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  Field,
  FieldError,
  FieldLabel,
  MoneyInput,
  ResponsiveTable,
  TextInput,
} from '../../components';
import type { ComboboxOption } from '../../components';
import {
  blankFormState,
  blankLine,
  formIsComplete,
  hasProblems,
  problemsIn,
  stateFromOrder,
  toCreateRequest,
  toUpdateRequest,
} from './order-state';
import type { LineProblem, OrderFormLine, OrderFormState } from './order-state';
import type { PurchaseOrder, PurchaseOrderReferenceData } from './queries';
import {
  useCreatePurchaseOrder,
  useIntentKey,
  usePurchaseOrder,
  useUpdatePurchaseOrder,
} from './queries';

/**
 * The one form for creating and editing a purchase order (OB-M3 wave; D-M3, D-M6, D-M7).
 *
 * ## Why the dialog can open on a loading state
 *
 * Editing needs the full order with its lines, and `PurchaseOrderPage.items` is
 * `PurchaseOrderSummary[]` — the list row this dialog opens from carries no lines at all.
 * So an edit fetches the order fresh the moment the dialog opens (`usePurchaseOrder`),
 * the same "detail is its own read" discipline `fixed-assets/schedule-view.tsx` keeps for a
 * row the caller's own page may not currently hold, and the dialog shows a brief loading
 * state rather than the create form's blank fields while that fetch is out.
 *
 * ## What this form does not collect
 *
 * No tax-rate control and no dimension picker (D-M7 — a purchase order carries no
 * dimension tags in v1; those are added once a converted bill exists). `taxMode` is not
 * asked either: `order-state.ts`'s `toCreateRequest` hard-codes it, because with no
 * tax-rate control on any line there is nothing for the mode to change the meaning of.
 *
 * ## Why this form is offered only on a draft
 *
 * `updatePurchaseOrder` answers `purchase_order_approved` once a purchase order has left
 * `draft` — approve, convert and send are the only operations left to it — so
 * `purchase-orders/list.tsx` never offers Edit past that point, and this dialog does not
 * try to degrade gracefully into a read view for the case; there is nothing left to edit.
 */
export interface OrderFormDialogProps {
  /** `null` creates; an order id edits it. */
  readonly orderId: string | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function OrderFormDialog({
  orderId,
  reference,
  open,
  onOpenChange,
}: OrderFormDialogProps): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed on the order, so a second "Edit" starts from that row's own fetch rather
          than the previous order's still-loading state. */}
      {open && (
        <OrderFormLoader
          key={orderId ?? 'new'}
          orderId={orderId}
          reference={reference}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function OrderFormLoader({
  orderId,
  reference,
  onDone,
}: {
  readonly orderId: string | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const detail = usePurchaseOrder(orderId);

  if (orderId !== null && detail.isPending) {
    return (
      <DialogContent
        title="Loading purchase order…"
        footer={
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
        }
      >
        <p className="text-text-subtle">Loading…</p>
      </DialogContent>
    );
  }

  if (orderId !== null && detail.error != null) {
    return (
      <DialogContent
        title="Purchase order"
        footer={
          <DialogClose asChild>
            <Button>Close</Button>
          </DialogClose>
        }
      >
        <ErrorBanner error={detail.error} />
      </DialogContent>
    );
  }

  return <OrderFormContent order={detail.order} reference={reference} onDone={onDone} />;
}

function OrderFormContent({
  order,
  reference,
  onDone,
}: {
  readonly order: PurchaseOrder | null;
  readonly reference: PurchaseOrderReferenceData;
  readonly onDone: () => void;
}): ReactElement {
  const formId = useId();
  const [state, setState] = useState<OrderFormState>(() =>
    order === null ? blankFormState() : stateFromOrder(order),
  );

  const create = useCreatePurchaseOrder();
  const update = useUpdatePurchaseOrder();
  const intentKey = useIntentKey();

  const pending = create.isPending || update.isPending;
  const error: unknown = create.error ?? update.error;
  const fieldErrors = presentApiError(error).fieldErrors;

  function edit(next: Partial<OrderFormState>): void {
    setState((current) => ({ ...current, ...next }));
  }

  function editLine(key: string, next: Partial<OrderFormLine>): void {
    setState((current) => ({
      ...current,
      lines: current.lines.map((line) => (line.key === key ? { ...line, ...next } : line)),
    }));
  }

  const vendorOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.vendors.map((vendor) => ({
        value: vendor.id,
        label: vendor.displayName,
        ...(vendor.code === null ? {} : { detail: vendor.code }),
        disabled: !vendor.isActive,
      })),
    [reference.vendors],
  );

  const accountOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.accounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        disabled: !account.isActive,
      })),
    [reference.accounts],
  );

  const problems = problemsIn(state);
  const complete = formIsComplete(state);

  function submit(): void {
    if (!complete) return;

    if (order === null) {
      const body = toCreateRequest(state);
      create.mutate(
        { ...body, idempotencyKey: intentKey(`create:${JSON.stringify(body)}`) },
        { onSuccess: onDone },
      );
      return;
    }

    const patch = toUpdateRequest(state);
    update.mutate(
      {
        purchaseOrderId: order.id,
        patch,
        idempotencyKey: intentKey(`update:${order.id}:${JSON.stringify(patch)}`),
      },
      { onSuccess: onDone },
    );
  }

  return (
    <DialogContent
      title={order === null ? 'New purchase order' : 'Edit purchase order'}
      description="A vendor, an issue date and — when there is one to name — an expected delivery date. Lines are optional here; the arity and account checks happen at approval."
      className="max-w-3xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Cancel</Button>
          </DialogClose>
          <Button type="submit" form={formId} variant="primary" disabled={pending || !complete}>
            {pending ? 'Saving…' : order === null ? 'Create' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {error !== undefined && error !== null && <ErrorBanner error={error} />}

        <div className="flex flex-wrap gap-4">
          <Field className="min-w-64 flex-1" error={fieldErrors['contactId']}>
            <FieldLabel>Vendor</FieldLabel>
            <Combobox
              options={vendorOptions}
              value={state.contactId}
              disabled={pending}
              placeholder="Search vendors…"
              onValueChange={(value) => {
                edit({ contactId: value });
              }}
            />
          </Field>

          <Field className="w-40" error={fieldErrors['issueDate']}>
            <FieldLabel>Issue date</FieldLabel>
            <TextInput
              type="date"
              value={state.issueDate}
              disabled={pending}
              onChange={(event) => {
                edit({ issueDate: event.target.value });
              }}
            />
          </Field>

          <Field
            className="w-40"
            error={fieldErrors['expectedDate']}
            hint="When the vendor is expected to deliver, if known. Purely informational."
          >
            <FieldLabel>Expected date</FieldLabel>
            <TextInput
              type="date"
              value={state.expectedDate}
              disabled={pending}
              onChange={(event) => {
                edit({ expectedDate: event.target.value });
              }}
            />
          </Field>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field className="min-w-64 flex-1" error={fieldErrors['reference']}>
            <FieldLabel>Reference</FieldLabel>
            <TextInput
              value={state.reference}
              disabled={pending}
              onChange={(event) => {
                edit({ reference: event.target.value });
              }}
            />
          </Field>

          <Field className="min-w-64 flex-1" error={fieldErrors['memo']}>
            <FieldLabel>Memo</FieldLabel>
            <TextInput
              value={state.memo}
              disabled={pending}
              onChange={(event) => {
                edit({ memo: event.target.value });
              }}
            />
          </Field>
        </div>

        <ResponsiveTable>
          <table className="w-full border-collapse">
            <caption className="sr-only">Purchase order lines</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-1 font-medium">
                  Description
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Quantity
                </th>
                <th scope="col" className="p-1 font-medium">
                  Account
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Unit price
                </th>
                <th scope="col" className="p-1 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.lines.map((line, index) => (
                <OrderLineRow
                  key={line.key}
                  line={line}
                  index={index}
                  accountOptions={accountOptions}
                  problem={problems.lines.get(line.key)}
                  disabled={pending}
                  onChange={(next) => {
                    editLine(line.key, next);
                  }}
                  onRemove={() => {
                    edit({ lines: state.lines.filter((existing) => existing.key !== line.key) });
                  }}
                />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>

        <div>
          <Button
            disabled={pending}
            onClick={() => {
              edit({ lines: [...state.lines, blankLine()] });
            }}
          >
            Add line
          </Button>
        </div>

        {fieldErrors['lines'] !== undefined && <FieldError>{fieldErrors['lines']}</FieldError>}
        {hasProblems(problems) && problems.lines.size > 0 && (
          <FieldError>
            Every line started needs a description, an account and a unit price.
          </FieldError>
        )}
      </form>
    </DialogContent>
  );
}

interface OrderLineRowProps {
  readonly line: OrderFormLine;
  readonly index: number;
  readonly accountOptions: readonly ComboboxOption[];
  readonly problem: LineProblem | undefined;
  readonly disabled: boolean;
  readonly onChange: (line: Partial<OrderFormLine>) => void;
  readonly onRemove: () => void;
}

const PROBLEM_MESSAGES: Readonly<Record<LineProblem, string>> = {
  description: 'This line needs a description — it is what prints on the purchase order.',
  account: 'This line needs an account to post to once it is converted.',
  unitAmount: 'This line needs a unit price.',
  quantity: 'This line needs a quantity.',
};

function OrderLineRow({
  line,
  index,
  accountOptions,
  problem,
  disabled,
  onChange,
  onRemove,
}: OrderLineRowProps): ReactElement {
  const position = String(index + 1);
  const message = problem === undefined ? undefined : PROBLEM_MESSAGES[problem];

  return (
    <tr className="align-top">
      <td className="p-1">
        <Field error={message}>
          <TextInput
            aria-label={`Description, line ${position}`}
            value={line.description}
            disabled={disabled}
            onChange={(event) => {
              onChange({ description: event.target.value });
            }}
          />
        </Field>
      </td>

      <td className="w-24 p-1">
        <Field>
          <TextInput
            aria-label={`Quantity, line ${position}`}
            inputMode="decimal"
            className="text-right font-mono tabular-nums"
            value={line.quantity}
            disabled={disabled}
            onChange={(event) => {
              onChange({ quantity: event.target.value });
            }}
          />
        </Field>
      </td>

      <td className="min-w-48 p-1">
        <Combobox
          aria-label={`Account, line ${position}`}
          value={line.accountId}
          options={accountOptions}
          disabled={disabled}
          placeholder="Search accounts…"
          onValueChange={(accountId) => {
            onChange({ accountId });
          }}
        />
      </td>

      <td className="w-32 p-1">
        <MoneyInput
          aria-label={`Unit price, line ${position}`}
          value={line.unitAmount}
          disabled={disabled}
          onValueChange={(unitAmount) => {
            onChange({ unitAmount });
          }}
        />
      </td>

      <td className="w-10 p-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove line ${position}`}
          disabled={disabled}
          onClick={onRemove}
        >
          ✕
        </Button>
      </td>
    </tr>
  );
}
