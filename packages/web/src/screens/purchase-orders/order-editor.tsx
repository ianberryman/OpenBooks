import { useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  TextInput,
  formatMoney,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { cx } from '../../lib/cx';
import { useIsCompact } from '../../lib/use-viewport';
import { ContactFormDialog } from '../contacts/contact-form';
import { CatalogItemDialog } from '../settings/catalog-item-dialog';
import { useCatalogItemChoices } from '../settings/catalog-queries';
import { LineCard, LineRow, applyCatalogItem } from './line-row';
import { OrderHeader } from './order-header';
import {
  blankLine,
  isUntouched,
  lineProblem,
  stateFromOrder,
  toUpdateRequest,
} from './order-state';
import type { OrderFormState, OrderLineDraft } from './order-state';
import {
  VENDORS_QUERY_KEY,
  useApprovePurchaseOrder,
  useDiscardPurchaseOrder,
  useIntentKey,
  useUpdatePurchaseOrder,
} from './queries';
import type { PurchaseOrder, PurchaseOrderReferenceData } from './queries';

/**
 * The draft editor, as a routed page rather than a dialog (PO redesign, the AP-side mirror of
 * `estimates/estimate-editor.tsx`) — ported from the old `order-form.tsx`'s `OrderFormContent`
 * and given the two writes that dialog never had: Approve and Discard.
 *
 * ## Always a saved draft, never a create branch
 *
 * The old form dialog served both `orderId: null` (create) and an id (edit) from one component.
 * This page only ever edits: the route that opens it (`purchase-orders.tsx`) pre-creates an
 * empty draft with `createPurchaseOrder` and navigates here with the id it got back — the same
 * "New" flow the estimate and invoice editors use. So `order` is always a real, saved
 * `PurchaseOrder`, and the only mutation that saves fields is `useUpdatePurchaseOrder`.
 *
 * ## Approve and Discard are inlined, not the folder's own dialogs
 *
 * `approve-dialog.tsx`/`discard-dialog.tsx` were built for `list.tsx`'s per-row actions: they
 * take a `PurchaseOrderSummary` and a plain `onOpenChange`, with no way to hand back what the
 * mutation produced. This page's Approve has to open Send on the *now-numbered* order
 * (`onApproved(approved, { openSend: true })`), so the mutation is inlined here — the hooks
 * straight from `queries.ts`, confirmed by a `Dialog` built inline the same way the estimate
 * editor builds its own Approve and Discard confirmations rather than indirecting through a
 * separate component.
 *
 * ## Nothing here computes tax or offers a tax-rate picker
 *
 * A purchase-order line carries no tax rate and `taxMode` never varies (`order-state.ts`'s file
 * header) — so this page has no tax-mode selector and its line table has no tax-rate, net, or
 * gross columns. `LineRow`/`LineCard` (`line-row.tsx`) are the four-column shape those omissions
 * leave: description, quantity, unit price, account. And a purchase order needs no line at all
 * to be saved (D-M7's arity checks belong at approval), so — unlike the estimate editor — this
 * one never nags that at least one line is required.
 */
export interface PurchaseOrderEditorProps {
  /** Always a saved draft — see the file header for why there is no create branch here. */
  readonly order: PurchaseOrder;
  readonly reference: PurchaseOrderReferenceData;
  /** Back to the list — the breadcrumb in `OrderHeader` calls it. */
  readonly onBack: () => void;
  readonly onApproved: (order: PurchaseOrder, opts?: { readonly openSend?: boolean }) => void;
  readonly onDiscarded: () => void;
}

export function PurchaseOrderEditor({
  order,
  reference,
  onBack,
  onApproved,
  onDiscarded,
}: PurchaseOrderEditorProps): ReactElement {
  const queryClient = useQueryClient();
  const isCompact = useIsCompact();

  const [state, setState] = useState<OrderFormState>(() => stateFromOrder(order));
  const [saved, setSaved] = useState<PurchaseOrder>(order);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'discard' | null>(null);
  const [newVendorName, setNewVendorName] = useState<string | null>(null);
  /**
   * The line that opened the inline "Create item" dialog, and the description it had typed —
   * held so the created item can be applied back to that line (D-CAT-2).
   */
  const [creatingItemFor, setCreatingItemFor] = useState<{ key: string; typed: string } | null>(
    null,
  );

  // A purchase order seeds from the purchase catalog; its picker suggests only active purchase items.
  const catalogItems = useCatalogItemChoices('purchase');

  const update = useUpdatePurchaseOrder();
  const approve = useApprovePurchaseOrder();
  const discard = useDiscardPurchaseOrder();
  const intentKey = useIntentKey();

  const busy = update.isPending || approve.isPending || discard.isPending;

  /**
   * The last refusal, held rather than derived from the three mutations: only the most recent
   * attempt is the one the user is looking at, and reading `update.error ?? approve.error` would
   * keep showing a stale failure a later successful save answered.
   */
  const [failure, setFailure] = useState<unknown>(null);
  const presented = failure === null ? null : presentApiError(failure);
  const fieldErrors = presented?.fieldErrors ?? {};

  function edit(next: OrderFormState): void {
    setState(next);
    setDirty(true);
  }

  function editLine(line: OrderLineDraft): void {
    edit({
      ...state,
      lines: state.lines.map((existing) => (existing.key === line.key ? line : existing)),
    });
  }

  const vendorOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.vendors.map((vendor) => ({
        value: vendor.id,
        label: vendor.displayName,
        ...(vendor.code === null ? {} : { detail: vendor.code }),
        // Archived vendors are listed and disabled rather than omitted, so a draft that already
        // names one still shows which vendor it is for.
        disabled: !vendor.isActive && vendor.id !== state.contactId,
      })),
    [reference.vendors, state.contactId],
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

  // A started-but-unfinished line — the only line-level nag this screen makes, since an entirely
  // blank trailing row is dropped on save (`isUntouched`) rather than complained about.
  const hasIncompleteLine = state.lines.some(
    (line) => !isUntouched(line) && lineProblem(line) !== null,
  );

  async function persist(): Promise<PurchaseOrder> {
    const patch = toUpdateRequest(state);
    const result = await update.mutateAsync({
      purchaseOrderId: order.id,
      patch,
      // Minted per save and never held against the order, so the *same* key with edited content
      // is an `idempotency_key_conflict` rather than a silent replay.
      idempotencyKey: intentKey(`update:${order.id}:${JSON.stringify(patch)}`),
    });
    // Re-read from the response rather than keeping the local copy — this is where the server's
    // own recompute of every line's figures arrives.
    setState(stateFromOrder(result));
    setSaved(result);
    setDirty(false);
    return result;
  }

  async function handleSave(): Promise<void> {
    setFailure(null);
    try {
      await persist();
    } catch (error) {
      setFailure(error);
    }
  }

  async function handleApprove(): Promise<void> {
    setFailure(null);
    setConfirming(null);
    try {
      // Approve saves first: it approves what the *server* holds, and an editor that let it run
      // against a stale stored draft would number a version the user cannot see.
      if (dirty) await persist();
      const approved = await approve.mutateAsync({
        purchaseOrderId: order.id,
        idempotencyKey: intentKey(`approve:${order.id}`),
      });
      setState(stateFromOrder(approved));
      setSaved(approved);
      // A fresh purchase order opens straight into Send, because approving one that is never
      // sent to the vendor is the common slip this button exists to prevent.
      onApproved(approved, { openSend: true });
    } catch (error) {
      // The draft is untouched: a refused approval rolls back, so it is still a draft, still
      // holds no number, and Approve is still the next thing to press.
      setFailure(error);
    }
  }

  async function handleDiscard(): Promise<void> {
    setFailure(null);
    setConfirming(null);
    try {
      await discard.mutateAsync({
        purchaseOrderId: order.id,
        idempotencyKey: intentKey(`discard:${order.id}`),
      });
      onDiscarded();
    } catch (error) {
      setFailure(error);
    }
  }

  const saveLabel = isCompact ? 'Save as draft' : 'Save draft';
  const primaryLabel = isCompact ? 'Save and send' : 'Approve & Send';

  /**
   * Built once and handed to `OrderHeader`, so the header's actions and the compact footer's
   * cannot drift on a handler even though the footer shows a smaller subset.
   */
  const actions = (
    <>
      <Button variant="danger" disabled={busy} onClick={() => setConfirming('discard')}>
        Discard
      </Button>
      <Button
        disabled={busy || !dirty}
        onClick={() => {
          void handleSave();
        }}
      >
        {update.isPending ? 'Saving…' : saveLabel}
      </Button>
      <Button variant="primary" disabled={busy} onClick={() => setConfirming('approve')}>
        {approve.isPending ? 'Approving…' : primaryLabel}
      </Button>
    </>
  );

  const incompleteHint = hasIncompleteLine && (
    <span className="text-xs text-text-subtle">
      Every line started needs a description, an account and a unit price.
    </span>
  );

  const memoField = (
    <Field className="w-full" error={fieldErrors['memo']} hint="Optional.">
      <FieldLabel>Memo</FieldLabel>
      <textarea
        className="min-h-24 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-base text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
        aria-label="Memo"
        value={state.memo}
        disabled={busy}
        onChange={(event) => {
          edit({ ...state, memo: event.target.value });
        }}
      />
    </Field>
  );

  const vendorField = (
    <Field className="min-w-64 flex-1" error={fieldErrors['contactId']}>
      <FieldLabel>Vendor</FieldLabel>
      <Combobox
        options={vendorOptions}
        value={state.contactId}
        disabled={busy}
        placeholder="Search vendors…"
        emptyMessage="No vendors yet."
        onValueChange={(value) => {
          edit({ ...state, contactId: value });
        }}
        onCreate={{
          label: (q) => (q.trim() === '' ? 'New vendor' : `Create "${q.trim()}"`),
          onSelect: (q) => {
            setNewVendorName(q.trim());
          },
        }}
      />
    </Field>
  );

  const issueDateField = (
    <Field className="w-44" error={fieldErrors['issueDate']}>
      <FieldLabel>Issue date</FieldLabel>
      <TextInput
        type="date"
        value={state.issueDate}
        disabled={busy}
        onChange={(event) => {
          edit({ ...state, issueDate: event.target.value });
        }}
      />
    </Field>
  );

  const expectedDateField = (
    <Field
      className="w-44"
      error={fieldErrors['expectedDate']}
      hint="Optional. When the vendor is expected to deliver — purely informational."
    >
      <FieldLabel>Expected date</FieldLabel>
      <TextInput
        type="date"
        value={state.expectedDate}
        disabled={busy}
        onChange={(event) => {
          edit({ ...state, expectedDate: event.target.value });
        }}
      />
    </Field>
  );

  const referenceField = (
    <Field className="w-56" error={fieldErrors['reference']} hint="Optional.">
      <FieldLabel>Reference</FieldLabel>
      <TextInput
        value={state.reference}
        disabled={busy}
        onChange={(event) => {
          edit({ ...state, reference: event.target.value });
        }}
      />
    </Field>
  );

  return (
    <section className="flex flex-col gap-4 pb-24 md:pb-6" aria-label="Purchase order draft">
      <OrderHeader document={saved} actions={actions} onNavigateList={onBack} />

      <p className="text-sm text-text-muted">
        {dirty ? 'Unsaved changes' : 'All changes saved'} — nothing here posts a journal; a purchase
        order is a commitment, and the ledger is told only once it is converted to a bill and that
        bill is approved.
      </p>

      {presented !== null && <ErrorBanner error={failure} />}

      {isCompact ? (
        <>
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
            {vendorField}
            <div className="flex gap-3">
              {issueDateField}
              {expectedDateField}
            </div>
            {referenceField}
          </div>

          <ul aria-label="Purchase order lines" className="flex flex-col gap-3">
            {state.lines.map((line, index) => (
              <LineCard
                key={line.key}
                line={line}
                index={index}
                accountOptions={accountOptions}
                catalogItems={catalogItems.data ?? []}
                fieldErrors={fieldErrors}
                disabled={busy}
                onChange={editLine}
                onCreateItem={(typed) => {
                  setCreatingItemFor({ key: line.key, typed });
                }}
                onRemove={() => {
                  edit({ ...state, lines: state.lines.filter((it) => it.key !== line.key) });
                }}
              />
            ))}
          </ul>

          <div className="flex items-center gap-3">
            <Button
              disabled={busy}
              onClick={() => {
                edit({ ...state, lines: [...state.lines, blankLine()] });
              }}
            >
              Add line
            </Button>
            {incompleteHint}
          </div>

          {memoField}

          <OrderTotalsCard order={saved} dirty={dirty} />

          {/**
           * The header's actions repeat here, reduced to the pair a thumb needs at the bottom of
           * a phone (D-120 compact tier) — the same handlers and labels as `actions`, not a
           * second implementation of either.
           */}
          <div className="no-print fixed inset-x-0 bottom-0 z-10 flex items-center justify-end gap-2 border-t border-border bg-surface p-3">
            <Button
              disabled={busy || !dirty}
              onClick={() => {
                void handleSave();
              }}
            >
              {update.isPending ? 'Saving…' : saveLabel}
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => setConfirming('approve')}>
              {approve.isPending ? 'Approving…' : primaryLabel}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-4 rounded-lg border border-border bg-surface p-4">
            {vendorField}
            {issueDateField}
            {expectedDateField}
            {referenceField}
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
                    Qty
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Unit price
                  </th>
                  <th scope="col" className="p-1 font-medium">
                    Account
                  </th>
                  <th scope="col" className="p-1 font-medium">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {state.lines.map((line, index) => (
                  <LineRow
                    key={line.key}
                    line={line}
                    index={index}
                    accountOptions={accountOptions}
                    catalogItems={catalogItems.data ?? []}
                    fieldErrors={fieldErrors}
                    disabled={busy}
                    onChange={editLine}
                    onCreateItem={(typed) => {
                      setCreatingItemFor({ key: line.key, typed });
                    }}
                    onRemove={() => {
                      edit({ ...state, lines: state.lines.filter((it) => it.key !== line.key) });
                    }}
                  />
                ))}
              </tbody>
            </table>
          </ResponsiveTable>

          <div className="flex items-center gap-3">
            <Button
              disabled={busy}
              onClick={() => {
                edit({ ...state, lines: [...state.lines, blankLine()] });
              }}
            >
              Add another line
            </Button>
            {incompleteHint}
          </div>

          {memoField}

          <div className="flex justify-end">
            <OrderTotalsCard order={saved} dirty={dirty} />
          </div>
        </>
      )}

      <Dialog
        open={confirming === 'approve'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <DialogContent
          title="Approve this purchase order?"
          description="Allocates its gapless number. There is no path back to draft from here — discard and re-issue is the correction, exactly as it is for any other approved document."
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Keep editing</Button>
              <Button
                variant="primary"
                onClick={() => {
                  void handleApprove();
                }}
              >
                {approve.isPending ? 'Approving…' : 'Approve'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            The purchase order will be numbered and ready to send or convert to a bill. Nothing here
            posts a journal — that happens only when this purchase order is converted to a bill and
            that bill is approved.
          </p>
          {approve.isError && <ErrorBanner error={approve.error} />}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming === 'discard'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <DialogContent
          title="Discard this purchase order?"
          description="It never carried a number and posts no journal, so there is nothing to reverse — the draft is simply removed."
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Keep editing</Button>
              <Button
                variant="danger"
                onClick={() => {
                  void handleDiscard();
                }}
              >
                {discard.isPending ? 'Discarding…' : 'Discard'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            Nothing in the ledger changes, because nothing about this draft ever reached it — and no
            number is freed, because none was allocated.
          </p>
          {discard.isError && <ErrorBanner error={discard.error} />}
        </DialogContent>
      </Dialog>

      {/* Inline vendor creation: seeded with the typed name and pre-marked a vendor, and on
          success the vendors list is refetched (this screen's own query key) and the new vendor
          selected. */}
      <ContactFormDialog
        contact={null}
        open={newVendorName !== null}
        onOpenChange={(open) => {
          if (!open) setNewVendorName(null);
        }}
        initialDisplayName={newVendorName ?? ''}
        initialIsVendor
        onCreated={(created) => {
          void queryClient.invalidateQueries({ queryKey: VENDORS_QUERY_KEY });
          edit({ ...state, contactId: created.id });
        }}
      />

      {/* Inline item creation from a line's description picker: preset to the purchase side and
          seeded with the typed text. On success the new item is applied to the line that asked
          for it (D-CAT-2), and the create mutation's own invalidation refetches the picker's
          choices. */}
      <CatalogItemDialog
        open={creatingItemFor !== null}
        onOpenChange={(open) => {
          if (!open) setCreatingItemFor(null);
        }}
        presetDirection="purchase"
        initialName={creatingItemFor?.typed ?? ''}
        onSaved={(item) => {
          const key = creatingItemFor?.key;
          if (key === undefined) return;
          edit({
            ...state,
            lines: state.lines.map((existing) =>
              existing.key === key ? applyCatalogItem(existing, item) : existing,
            ),
          });
        }}
      />
    </section>
  );
}

/**
 * Subtotal / tax / total, read off `order.totals` rather than computed here — the same
 * server-is-the-only-arithmetic rule the estimate and sales totals follow. A purchase order
 * settles nothing, so there is no outstanding-balance line to subtract.
 */
function OrderTotalsCard({
  order,
  dirty,
}: {
  readonly order: PurchaseOrder;
  readonly dirty: boolean;
}): ReactElement {
  const stale = cx('font-mono tabular-nums', dirty && 'text-text-subtle');

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-surface p-4 sm:w-72">
      <div className="flex justify-between text-sm text-text-muted">
        <span>Subtotal</span>
        <span className={stale}>{formatMoney(order.totals.net)}</span>
      </div>
      <div className="flex justify-between text-sm text-text-muted">
        <span>Tax</span>
        <span className={stale}>{formatMoney(order.totals.tax)}</span>
      </div>
      <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-text">
        <span>Total</span>
        <span className={cx('font-mono tabular-nums', dirty && 'text-text-subtle')}>
          {formatMoney(order.totals.gross)}
        </span>
      </div>
      {dirty && <p className="text-xs text-text-subtle">Recalculated when this draft is saved.</p>}
    </div>
  );
}
