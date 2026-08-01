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
import { EstimateHeader } from './estimate-header';
import { blankLine, lineIsComplete, stateFromEstimate, toUpdateRequest } from './estimate-state';
import type { EstimateFormState, EstimateLineDraft } from './estimate-state';
import { LineCard, LineRow, applyCatalogItem } from './line-row';
import {
  CONTACTS_QUERY_KEY,
  useApproveEstimate,
  useDiscardEstimate,
  useIntentKey,
  useUpdateEstimate,
} from './queries';
import type { Estimate, EstimateReferenceData } from './queries';

/**
 * The draft editor, as a routed page rather than a dialog (estimates redesign, AGENT
 * E-EDITOR) — `sales/document-editor.tsx`'s shape, ported from the old
 * `estimate-form.tsx`'s `EstimateFormContent` and given the two writes that dialog never
 * had: Approve and Discard.
 *
 * ## Always a saved draft, never a create branch
 *
 * The old form dialog served both `estimateId: null` (create) and an id (edit) from one
 * component. This page only ever edits: the route that opens it (the orchestrator's
 * `estimates.tsx`) pre-creates an empty draft with `createEstimate` and navigates here with
 * the id it got back — the same "New" flow `sales.tsx` uses for an invoice. So `estimate`
 * is always a real, saved `Estimate`, and the only mutation that saves fields is
 * `useUpdateEstimate` (`estimate-form.tsx`'s `toCreateRequest`/`useCreateEstimate` path has
 * no equivalent here).
 *
 * ## Approve and Discard are inlined, not the folder's own dialogs
 *
 * `approve-dialog.tsx`/`discard-dialog.tsx` were built for `list.tsx`'s per-row actions:
 * they take an `EstimateSummary` and a plain `onOpenChange`, with no way to hand back what
 * the mutation produced. This page's Approve has to open Send on the *now-numbered*
 * estimate (`onApproved(approved, { openSend: true })`), so the mutation is inlined here —
 * `useApproveEstimate`/`useDiscardEstimate` straight from `queries.ts`, confirmed by a
 * `Dialog` built inline exactly the way `sales/document-editor.tsx` builds its own Approve
 * and Discard confirmations rather than indirecting through a separate component.
 *
 * ## Nothing here computes tax or offers a tax-rate picker
 *
 * An estimate line carries no tax rate and `taxMode` never varies (`estimate-state.ts`'s
 * file header) — so unlike the sales editor this page has no tax-mode selector, no
 * reprice-confirmation dialog, and its line table has no tax-rate, net, or gross columns.
 * `LineRow`/`LineCard` here (`line-row.tsx`) are the four-column shape those omissions
 * leave: description, quantity, unit price, account.
 */
export interface EstimateEditorProps {
  /** Always a saved draft — see the file header for why there is no create branch here. */
  readonly estimate: Estimate;
  readonly reference: EstimateReferenceData;
  readonly onApproved: (estimate: Estimate, opts?: { readonly openSend?: boolean }) => void;
  readonly onDiscarded: () => void;
  /** Back to the list — the breadcrumb in `EstimateHeader` calls it. */
  readonly onBack: () => void;
}

export function EstimateEditor({
  estimate,
  reference,
  onApproved,
  onDiscarded,
  onBack,
}: EstimateEditorProps): ReactElement {
  const queryClient = useQueryClient();
  const isCompact = useIsCompact();
  const asOf = new Date().toISOString().slice(0, 10);

  const [state, setState] = useState<EstimateFormState>(() => stateFromEstimate(estimate));
  const [saved, setSaved] = useState<Estimate>(estimate);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'discard' | null>(null);
  const [newCustomerName, setNewCustomerName] = useState<string | null>(null);
  /**
   * The line that opened the inline "Create item" dialog, and the description it had
   * typed — held so the created item can be applied back to that line (D-CAT-2).
   */
  const [creatingItemFor, setCreatingItemFor] = useState<{ key: string; typed: string } | null>(
    null,
  );

  // An estimate seeds from the sales catalog; its picker suggests only active sales items.
  const catalogItems = useCatalogItemChoices('sales');

  const update = useUpdateEstimate();
  const approve = useApproveEstimate();
  const discard = useDiscardEstimate();
  const intentKey = useIntentKey();

  const busy = update.isPending || approve.isPending || discard.isPending;

  /**
   * The last refusal, held rather than derived from the three mutations: only the most
   * recent attempt is the one the user is looking at, and reading `update.error ??
   * approve.error` would keep showing a stale failure a later successful save answered.
   */
  const [failure, setFailure] = useState<unknown>(null);
  const presented = failure === null ? null : presentApiError(failure);
  const fieldErrors = presented?.fieldErrors ?? {};

  function edit(next: EstimateFormState): void {
    setState(next);
    setDirty(true);
  }

  function editLine(line: EstimateLineDraft): void {
    edit({
      ...state,
      lines: state.lines.map((existing) => (existing.key === line.key ? line : existing)),
    });
  }

  const customerOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.customers.map((contact) => ({
        value: contact.id,
        label: contact.displayName,
        ...(contact.code === null ? {} : { detail: contact.code }),
        // Archived contacts are listed and disabled rather than omitted, so a draft that
        // already names one still shows which customer it is for.
        disabled: !contact.isActive && contact.id !== state.contactId,
      })),
    [reference.customers, state.contactId],
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

  const linesComplete = state.lines.length > 0 && state.lines.every(lineIsComplete);

  async function persist(): Promise<Estimate> {
    const patch = toUpdateRequest(state);
    const result = await update.mutateAsync({
      estimateId: estimate.id,
      patch,
      // Minted per save and never held against the estimate, so the *same* key with edited
      // content is an `idempotency_key_conflict` rather than a silent replay.
      idempotencyKey: intentKey(`update:${estimate.id}:${JSON.stringify(patch)}`),
    });
    // Re-read from the response rather than keeping the local copy — this is where the
    // server's own recompute of every line's figures arrives.
    setState(stateFromEstimate(result));
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
      // Approve saves first: it approves what the *server* holds, and an editor that let
      // it run against a stale stored draft would number a version the user cannot see.
      if (dirty) await persist();
      const approved = await approve.mutateAsync({
        estimateId: estimate.id,
        idempotencyKey: intentKey(`approve:${estimate.id}`),
      });
      setState(stateFromEstimate(approved));
      setSaved(approved);
      // A fresh estimate opens straight into Send, because approving one that is never
      // sent to the customer is the common slip this button exists to prevent.
      onApproved(approved, { openSend: true });
    } catch (error) {
      // The draft is untouched: a refused approval rolls back, so it is still a draft,
      // still holds no number, and Approve is still the next thing to press.
      setFailure(error);
    }
  }

  async function handleDiscard(): Promise<void> {
    setFailure(null);
    setConfirming(null);
    try {
      await discard.mutateAsync({
        estimateId: estimate.id,
        idempotencyKey: intentKey(`discard:${estimate.id}`),
      });
      onDiscarded();
    } catch (error) {
      setFailure(error);
    }
  }

  const saveLabel = isCompact ? 'Save as draft' : 'Save draft';
  const primaryLabel = isCompact ? 'Save and send' : 'Approve & Send';

  /**
   * Built once and handed to `EstimateHeader`, so the header's actions and the compact
   * footer's cannot drift on a handler even though the footer shows a smaller subset.
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

  const memoField = (
    <Field className="w-full" error={fieldErrors['memo']} hint="Optional.">
      <FieldLabel>Notes / Terms</FieldLabel>
      <textarea
        className="min-h-24 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-base text-text placeholder:text-text-subtle focus:outline-none focus:ring-2 focus:ring-accent"
        aria-label="Notes / Terms"
        value={state.memo}
        disabled={busy}
        onChange={(event) => {
          edit({ ...state, memo: event.target.value });
        }}
      />
    </Field>
  );

  const customerField = (
    <Field className="min-w-64 flex-1" error={fieldErrors['contactId']}>
      <FieldLabel>Customer</FieldLabel>
      <Combobox
        options={customerOptions}
        value={state.contactId}
        disabled={busy}
        placeholder="Search customers…"
        emptyMessage="No customers yet."
        onValueChange={(value) => {
          edit({ ...state, contactId: value });
        }}
        onCreate={{
          label: (q) => (q.trim() === '' ? 'New customer' : `Create "${q.trim()}"`),
          onSelect: (q) => {
            setNewCustomerName(q.trim());
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

  const expiryDateField = (
    <Field
      className="w-44"
      error={fieldErrors['expiryDate']}
      hint="Optional. Purely informational — nothing enforces it."
    >
      <FieldLabel>Expiry date</FieldLabel>
      <TextInput
        type="date"
        value={state.expiryDate}
        disabled={busy}
        onChange={(event) => {
          edit({ ...state, expiryDate: event.target.value });
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
    <section className="flex flex-col gap-4 pb-24 md:pb-6" aria-label="Estimate draft">
      <EstimateHeader document={saved} asOf={asOf} actions={actions} onNavigateList={onBack} />

      <p className="text-sm text-text-muted">
        {dirty ? 'Unsaved changes' : 'All changes saved'} — nothing here posts a journal until this
        estimate is approved and converted to an invoice.
      </p>

      {presented !== null && <ErrorBanner error={failure} />}

      {isCompact ? (
        <>
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
            {customerField}
            <div className="flex gap-3">
              {issueDateField}
              {expiryDateField}
            </div>
            {referenceField}
          </div>

          <ul aria-label="Estimate lines" className="flex flex-col gap-3">
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
            {state.lines.length === 0 ? (
              <span className="text-xs text-text-subtle">
                At least one line is required to approve.
              </span>
            ) : (
              !linesComplete && (
                <span className="text-xs text-text-subtle">
                  Every line needs a quantity, a unit price and an account.
                </span>
              )
            )}
          </div>

          {memoField}

          <EstimateTotalsCard estimate={saved} dirty={dirty} />

          {/**
           * The header's actions repeat here, reduced to the pair a thumb needs at the
           * bottom of a phone (D-120 compact tier) — the same handlers and labels as
           * `actions`, not a second implementation of either.
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
            {customerField}
            {issueDateField}
            {expiryDateField}
            {referenceField}
          </div>

          <ResponsiveTable>
            <table className="w-full border-collapse">
              <caption className="sr-only">Estimate lines</caption>
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
            {state.lines.length === 0 ? (
              <span className="text-xs text-text-subtle">
                At least one line is required to approve.
              </span>
            ) : (
              !linesComplete && (
                <span className="text-xs text-text-subtle">
                  Every line needs a quantity, a unit price and an account.
                </span>
              )
            )}
          </div>

          {memoField}

          <div className="flex justify-end">
            <EstimateTotalsCard estimate={saved} dirty={dirty} />
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
          title="Approve this estimate?"
          description="Allocates its gapless number. There is no path back to draft from here — discard and re-quote is the correction, exactly as it is for any other approved document."
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
            The estimate will be numbered and ready to send or convert. Nothing here posts a journal
            — that happens only when the customer accepts and this estimate is converted to an
            invoice.
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
          title="Discard this estimate?"
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

      {/* Inline customer creation: seeded with the typed name and pre-marked a customer, and
          on success the contacts list is refetched (this screen's own query key) and the new
          customer selected. */}
      <ContactFormDialog
        contact={null}
        open={newCustomerName !== null}
        onOpenChange={(open) => {
          if (!open) setNewCustomerName(null);
        }}
        initialDisplayName={newCustomerName ?? ''}
        initialIsCustomer
        onCreated={(created) => {
          void queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY });
          edit({ ...state, contactId: created.id });
        }}
      />

      {/* Inline item creation from a line's description picker: preset to the sales side and
          seeded with the typed text. On success the new item is applied to the line that
          asked for it (D-CAT-2), and the create mutation's own invalidation refetches the
          picker's choices. */}
      <CatalogItemDialog
        open={creatingItemFor !== null}
        onOpenChange={(open) => {
          if (!open) setCreatingItemFor(null);
        }}
        presetDirection="sales"
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
 * Subtotal / tax / total, read off `estimate.totals` rather than computed here — the same
 * server-is-the-only-arithmetic rule `sales/totals.tsx`'s `TotalsPanel` follows, minus the
 * outstanding-balance line that panel adds: an estimate settles nothing, so there is
 * nothing to subtract from the total.
 */
function EstimateTotalsCard({
  estimate,
  dirty,
}: {
  readonly estimate: Estimate;
  readonly dirty: boolean;
}): ReactElement {
  const stale = cx('font-mono tabular-nums', dirty && 'text-text-subtle');

  return (
    <div className="flex w-full flex-col gap-2 rounded-lg border border-border bg-surface p-4 sm:w-72">
      <div className="flex justify-between text-sm text-text-muted">
        <span>Subtotal</span>
        <span className={stale}>{formatMoney(estimate.totals.net)}</span>
      </div>
      <div className="flex justify-between text-sm text-text-muted">
        <span>Tax</span>
        <span className={stale}>{formatMoney(estimate.totals.tax)}</span>
      </div>
      <div className="flex justify-between border-t border-border pt-2 text-base font-semibold text-text">
        <span>Total</span>
        <span className={cx('font-mono tabular-nums', dirty && 'text-text-subtle')}>
          {formatMoney(estimate.totals.gross)}
        </span>
      </div>
      {dirty && <p className="text-xs text-text-subtle">Recalculated when this draft is saved.</p>}
    </div>
  );
}
