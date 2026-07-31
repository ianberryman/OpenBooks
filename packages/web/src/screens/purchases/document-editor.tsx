import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
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
  FieldError,
  FieldLabel,
  ResponsiveTable,
  Select,
  TextInput,
  formatMinorUnits,
} from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import type { ComboboxOption, SelectOption } from '../../components';
import { AllocateDialog } from './allocate-dialog';
import { STATUS_LABELS, allocateVendorCredit, documentApi, vocabularyFor } from './ap-document';
import type { ApDocument, DocumentKind } from './ap-document';
import {
  blankLine,
  emptyState,
  fingerprintOf,
  hasProblems,
  inputFromState,
  isUntouched,
  problemsIn,
  stateFromDocument,
  todayIsoDate,
} from './editor-state';
import type { EditorLine, EditorState } from './editor-state';
import { NO_TAX_RATE, LineCard, LineRow } from './line-row';
import type { LineRowProps } from './line-row';
import { documentIntentKey, releaseDocumentIntentKey, useFingerprintKey } from './intent-keys';
import type { BillSummary, DocumentStatus, ReferenceData } from './queries';
import { DuplicateVendorReference, isDuplicateVendorReference } from './refusal';

/**
 * The bill and vendor-credit editor (OB-069; ROADMAP D-34 to D-39).
 *
 * ## The line the whole screen is arranged around
 *
 * D-38: `draft → approved → (part_paid → paid)`, with `void` alongside, and **only
 * approval posts a journal**. Before it the document is editable and discardable exactly
 * as a journal draft is; after it the ledger has been told and the correction is a vendor
 * credit or a void, never an edit. So every control that changes the document disappears
 * at approval rather than being disabled with an explanation, and the two that appear —
 * Void, and Apply credit — are the two that are still true.
 *
 * Approval is `POST …/approve`, not a patch of `status`. Status is derived from the
 * journal columns and the allocations (D-34, D-38) and the API refuses a client writing
 * it; a screen that sent one would be asking for a computed field to be set.
 *
 * ## Nothing on this screen prices anything
 *
 * `taxMode` decides what `unitAmount` *means* (D-35), so changing it reprices every line.
 * The repricing is the server's — tax is computed per line and rounded per line by one
 * implementation, and the document's total is the sum of rounded lines rather than the
 * rounded sum, which is the only version a person adding up the page can verify. This
 * editor therefore shows the figures from the last save and **blanks them while the
 * document is dirty**, rather than estimating. The same rule covers `settlement`: what is
 * outstanding is total minus allocations computed on read (D-34), and it is displayed, not
 * derived.
 *
 * ## Idempotency
 *
 * Approve carries one key per document, held against the id in `intent-keys.ts`, so a
 * double click and a retry after a refusal are one intent. Save and void carry a key bound
 * to what they send, because those routes fingerprint their body.
 */
export interface DocumentEditorProps {
  readonly kind: DocumentKind;
  /** `null` while the document has never been saved — a create, not an edit. */
  readonly document: ApDocument | null;
  readonly reference: ReferenceData;
  /** This vendor's bills, for the allocation dialog. Empty for a bill editor. */
  readonly vendorBills: readonly BillSummary[];
  readonly onCreated: (documentId: string) => void;
  readonly onDiscarded: () => void;
  readonly onFindDuplicate: (contactId: string, vendorReference: string) => void;
}

const APPROVE = 'approve';

/** A status a client may not write; shown, never sent. */
function StatusBadge({ status }: { readonly status: DocumentStatus }): ReactElement {
  const classes: Readonly<Record<DocumentStatus, string>> = {
    draft: 'border-border bg-surface-sunken text-text-muted',
    approved: 'border-accent-soft bg-accent-soft text-text',
    part_paid: 'border-warning-border bg-warning-soft text-warning-text',
    paid: 'border-success-border bg-success-soft text-success-text',
    void: 'border-danger-border bg-danger-soft text-danger-text',
  };

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${classes[status]}`}
      data-status={status}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function invalidatePurchases(queryClient: QueryClient): void {
  // Both halves, always: an allocation written from a vendor credit changes what is
  // outstanding on a bill, and D-34 means that figure lives nowhere but a fresh read.
  void queryClient.invalidateQueries({ queryKey: ['purchases', 'bills'] });
  void queryClient.invalidateQueries({ queryKey: ['purchases', 'bill'] });
  void queryClient.invalidateQueries({ queryKey: ['purchases', 'vendor-credits'] });
  void queryClient.invalidateQueries({ queryKey: ['purchases', 'vendor-credit'] });
}

export function DocumentEditor({
  kind,
  document,
  reference,
  vendorBills,
  onCreated,
  onDiscarded,
  onFindDuplicate,
}: DocumentEditorProps): ReactElement {
  const queryClient = useQueryClient();
  const vocabulary = vocabularyFor(kind);
  const client = useMemo(() => documentApi(kind), [kind]);
  const saveKeyFor = useFingerprintKey();
  const voidKeyFor = useFingerprintKey();
  const allocateKeyFor = useFingerprintKey();

  const [state, setState] = useState<EditorState>(() =>
    document === null ? emptyState() : stateFromDocument(document),
  );
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<ApDocument | null>(document);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [voidingDate, setVoidingDate] = useState<string | null>(null);
  const [voidMemo, setVoidMemo] = useState('');
  const [allocating, setAllocating] = useState(false);
  /**
   * Bumped to move focus into the vendor's-number field, which is the recovery a duplicate
   * refusal offers. A remount rather than a ref because `TextInput` exposes neither — it
   * mints its id inside `Field` and takes no `ref` — and remounting a controlled input
   * costs nothing, since its value comes from state either way.
   */
  const [referenceFocusNonce, setReferenceFocusNonce] = useState(0);

  const status: DocumentStatus = saved?.status ?? 'draft';
  const readOnly = status !== 'draft';
  /** True exactly when the figures on screen are the server's for the content on screen. */
  const priced = saved !== null && !dirty;

  const accountOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.accounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        // Archived accounts stay on every document that names one and cannot be chosen for
        // a new line. Listed and disabled rather than hidden, so an older bill still shows
        // which account it posts to.
        disabled: !account.isActive,
      })),
    [reference.accounts],
  );

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

  const taxRateOptions = useMemo<SelectOption[]>(
    () => [
      // First, and a real choice rather than a placeholder: D-35 gives a line at most one
      // rate and **no default**, because a rate nobody chose is a rate that ends up on a
      // filing. "No tax" is also not "zero-rated", which a return reports separately.
      { value: NO_TAX_RATE, label: 'No tax' },
      ...reference.taxRates.map((rate) => ({
        value: rate.id,
        label: `${rate.name} (${rate.percentage}%)`,
        disabled: !rate.isActive,
      })),
    ],
    [reference.taxRates],
  );

  const problems = problemsIn(state);
  const presented = failure === null ? null : presentApiError(failure);
  const fieldErrors = presented?.fieldErrors ?? {};

  /**
   * Server field messages arrive keyed by the dotted path `ValidationIssue` uses, and the
   * index in `lines.N.…` is an index into the array that was **sent** — which drops the
   * untouched rows. Walked in the same order rather than assumed equal to the row index,
   * because a blank row above a real one would shift every message by one.
   */
  const serverLineErrors = useMemo(() => {
    const messages = new Map<string, string>();
    let sentIndex = 0;
    for (const line of state.lines) {
      if (isUntouched(line)) continue;
      for (const field of ['description', 'quantity', 'accountId', 'unitAmount', 'taxRateId']) {
        const message = fieldErrors[`lines.${String(sentIndex)}.${field}`];
        if (message !== undefined && !messages.has(line.key)) messages.set(line.key, message);
      }
      sentIndex += 1;
    }
    return messages;
  }, [state.lines, fieldErrors]);

  /** The server's gross for a line, matched by the id it came back with. */
  const grossByLineKey = useMemo(() => {
    const gross = new Map<string, string>();
    for (const line of saved?.lines ?? []) gross.set(line.lineId, line.grossAmount);
    return gross;
  }, [saved]);

  const saveDocument = useMutation({
    mutationFn: async (variables: { readonly idempotencyKey: string }) => {
      const input = inputFromState(state, kind === 'bill');
      return saved === null
        ? client.create(input, variables.idempotencyKey)
        : client.update(saved.id, input, variables.idempotencyKey);
    },
  });

  const approveDocument = useMutation({
    mutationFn: async (variables: { readonly id: string; readonly idempotencyKey: string }) =>
      client.approve(variables.id, variables.idempotencyKey),
  });

  const discardDocument = useMutation({
    mutationFn: async (variables: { readonly id: string; readonly idempotencyKey: string }) => {
      await client.discard(variables.id, variables.idempotencyKey);
    },
  });

  const voidDocument = useMutation({
    mutationFn: async (variables: {
      readonly id: string;
      readonly date: string;
      readonly memo: string | null;
      readonly idempotencyKey: string;
    }) =>
      client.voidDocument(
        variables.id,
        { date: variables.date, memo: variables.memo },
        variables.idempotencyKey,
      ),
  });

  const applyCredit = useMutation({
    mutationFn: async (variables: {
      readonly id: string;
      readonly allocations: readonly { targetId: string; amount: string }[];
      readonly idempotencyKey: string;
    }) => {
      await allocateVendorCredit(variables.id, variables.allocations, variables.idempotencyKey);
    },
  });

  const busy =
    saveDocument.isPending ||
    approveDocument.isPending ||
    discardDocument.isPending ||
    voidDocument.isPending ||
    applyCredit.isPending;

  function edit(next: EditorState): void {
    setState(next);
    setDirty(true);
  }

  const isCompact = useIsCompact();

  /**
   * The props one line hands to either `LineRow` (table) or `LineCard` (compact) — built
   * once so the two presentations are driven from the same source and cannot disagree on a
   * handler.
   */
  function lineProps(line: EditorLine, index: number): LineRowProps {
    return {
      line,
      index,
      accountOptions,
      taxRateOptions,
      grossAmount: priced ? (grossByLineKey.get(line.key) ?? null) : null,
      problem: problems.lines.get(line.key),
      serverError: serverLineErrors.get(line.key),
      disabled: busy,
      readOnly,
      onChange: (next: EditorLine) => {
        edit({
          ...state,
          lines: state.lines.map((existing) => (existing.key === next.key ? next : existing)),
        });
      },
      onRemove: () => {
        edit({ ...state, lines: state.lines.filter((it) => it.key !== line.key) });
      },
    };
  }

  function adopt(next: ApDocument): void {
    // Re-read from the response rather than keeping the local copy: the server settled the
    // arithmetic and issued the line ids this table keys its figures on.
    setSaved(next);
    setState(stateFromDocument(next));
    setDirty(false);
    invalidatePurchases(queryClient);
  }

  async function persist(): Promise<ApDocument> {
    const input = inputFromState(state, kind === 'bill');
    const wasCreate = saved === null;
    const next = await saveDocument.mutateAsync({
      idempotencyKey: saveKeyFor(fingerprintOf(input)),
    });
    adopt(next);
    if (wasCreate) onCreated(next.id);
    return next;
  }

  async function handleSave(): Promise<void> {
    setFailure(null);
    if (hasProblems(problems)) return;
    try {
      await persist();
    } catch (error) {
      setFailure(error);
    }
  }

  /**
   * Approve, which is the irreversible step.
   *
   * Unsaved edits are flushed first, for `postDraft`'s reason: `approveBill` carries no
   * body and approves what the *server* holds, so approving over a stale draft would post
   * a document the user cannot see. The approve key is minted per document rather than per
   * click, so a double click — and a retry after the duplicate-reference refusal — is one
   * intent (`intent-keys.ts`).
   */
  async function handleApprove(): Promise<void> {
    setFailure(null);
    if (hasProblems(problems)) return;
    try {
      const current = dirty || saved === null ? await persist() : saved;
      const approved = await approveDocument.mutateAsync({
        id: current.id,
        idempotencyKey: documentIntentKey(APPROVE, current.id),
      });
      adopt(approved);
    } catch (error) {
      setFailure(error);
    }
  }

  async function handleDiscard(): Promise<void> {
    setFailure(null);
    setConfirmingDiscard(false);
    if (saved === null) {
      onDiscarded();
      return;
    }
    try {
      await discardDocument.mutateAsync({
        id: saved.id,
        idempotencyKey: documentIntentKey('discard', saved.id),
      });
      releaseDocumentIntentKey(APPROVE, saved.id);
      releaseDocumentIntentKey('discard', saved.id);
      invalidatePurchases(queryClient);
      onDiscarded();
    } catch (error) {
      setFailure(error);
    }
  }

  async function handleVoid(date: string): Promise<void> {
    setFailure(null);
    if (saved === null) return;
    const memo = voidMemo.trim() === '' ? null : voidMemo.trim();
    try {
      const voided = await voidDocument.mutateAsync({
        id: saved.id,
        date,
        memo,
        idempotencyKey: voidKeyFor(`${saved.id}:${date}:${memo ?? ''}`),
      });
      setVoidingDate(null);
      adopt(voided);
    } catch (error) {
      setFailure(error);
    }
  }

  async function handleApply(
    allocations: readonly { targetId: string; amount: string }[],
  ): Promise<void> {
    setFailure(null);
    if (saved === null) return;
    try {
      await applyCredit.mutateAsync({
        id: saved.id,
        allocations,
        idempotencyKey: allocateKeyFor(JSON.stringify(allocations)),
      });
      setAllocating(false);
      invalidatePurchases(queryClient);
      // Re-read rather than adjust locally: what is left on this credit is total minus
      // allocations computed on read (D-34), and subtracting here would be the second
      // answer that decision exists to prevent.
      adopt(await client.get(saved.id));
    } catch (error) {
      setFailure(error);
    }
  }

  const vendorName =
    state.contactId === null
      ? 'this vendor'
      : (reference.vendorsById.get(state.contactId)?.displayName ?? 'this vendor');

  const showDuplicate = isDuplicateVendorReference(failure);

  return (
    <section
      className="flex flex-col gap-4"
      aria-label={kind === 'bill' ? 'Bill editor' : 'Vendor credit editor'}
    >
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-col">
          <span className="text-xs text-text-subtle">{vocabulary.ourNumberLabel}</span>
          <span className="font-mono text-md text-text">
            {saved?.documentNumber ?? 'Not assigned until approval'}
          </span>
        </div>
        <StatusBadge status={status} />
        <div className="flex-1" />
        {saved !== null && readOnly && (
          <div className="flex gap-6">
            <div className="flex flex-col text-right">
              <span className="text-xs text-text-subtle">Applied</span>
              <span className="font-mono text-md tabular-nums text-text">
                {formatMinorUnits(saved.settlement.allocated)}
              </span>
            </div>
            <div className="flex flex-col text-right">
              <span className="text-xs text-text-subtle">{vocabulary.outstandingLabel}</span>
              <span className="font-mono text-md tabular-nums text-text">
                {formatMinorUnits(saved.settlement.outstanding)}
              </span>
            </div>
          </div>
        )}
      </div>

      {showDuplicate ? (
        <DuplicateVendorReference
          error={failure}
          vendorName={vendorName}
          reference={state.reference}
          onFindExisting={() => {
            if (state.contactId !== null) onFindDuplicate(state.contactId, state.reference.trim());
          }}
          onEditReference={() => {
            setFailure(null);
            setReferenceFocusNonce((nonce) => nonce + 1);
          }}
        />
      ) : (
        presented !== null && <ErrorBanner error={failure} />
      )}

      <div className="flex flex-wrap gap-4">
        <Field className="w-64" error={fieldErrors['contactId']}>
          <FieldLabel>Vendor</FieldLabel>
          {readOnly ? (
            <p className="text-base text-text">{vendorName}</p>
          ) : (
            <Combobox
              value={state.contactId}
              options={vendorOptions}
              disabled={busy}
              onValueChange={(contactId) => {
                edit({ ...state, contactId });
              }}
            />
          )}
        </Field>

        <Field className="w-40" error={fieldErrors['issueDate']}>
          <FieldLabel>Issue date</FieldLabel>
          {readOnly ? (
            <p className="font-mono text-base text-text">{state.issueDate}</p>
          ) : (
            <TextInput
              type="date"
              value={state.issueDate}
              disabled={busy}
              onChange={(event) => {
                edit({ ...state, issueDate: event.target.value });
              }}
            />
          )}
        </Field>

        {kind === 'bill' && (
          <Field className="w-40" error={fieldErrors['dueDate']}>
            <FieldLabel>Due date</FieldLabel>
            {readOnly ? (
              <p className="font-mono text-base text-text">{state.dueDate}</p>
            ) : (
              <TextInput
                type="date"
                value={state.dueDate}
                disabled={busy}
                onChange={(event) => {
                  edit({ ...state, dueDate: event.target.value });
                }}
              />
            )}
          </Field>
        )}

        {/**
         * The field the ticket turns on. The label names **whose** number it is, because a
         * user who types our own number here has recorded the wrong thing and nothing
         * downstream will complain — the document still totals, the journal still balances,
         * and the vendor's remittance still will not match (D-36).
         */}
        <Field className="w-64" error={fieldErrors['reference']} hint={vocabulary.referenceHint}>
          <FieldLabel>{vocabulary.referenceLabel}</FieldLabel>
          {readOnly ? (
            <p className="font-mono text-base text-text">{state.reference || '—'}</p>
          ) : (
            <TextInput
              key={referenceFocusNonce}
              autoFocus={referenceFocusNonce > 0}
              placeholder="As printed by the vendor"
              value={state.reference}
              disabled={busy}
              onChange={(event) => {
                edit({ ...state, reference: event.target.value });
              }}
            />
          )}
        </Field>

        <Field
          className="w-64"
          hint={
            'Decides what a unit price means, and changing it reprices the document. The server ' +
            'computes the tax — save the draft to see the new figures.'
          }
        >
          <FieldLabel>Unit prices</FieldLabel>
          {readOnly ? (
            <p className="text-base text-text">
              {state.taxMode === 'inclusive' ? 'Include tax' : 'Exclude tax'}
            </p>
          ) : (
            <Select
              value={state.taxMode}
              options={[
                { value: 'exclusive', label: 'Exclude tax' },
                { value: 'inclusive', label: 'Include tax' },
              ]}
              disabled={busy}
              onValueChange={(taxMode) => {
                edit({ ...state, taxMode: taxMode === 'inclusive' ? 'inclusive' : 'exclusive' });
              }}
            />
          )}
        </Field>

        <Field className="min-w-64 flex-1" error={fieldErrors['memo']}>
          <FieldLabel>Memo</FieldLabel>
          {readOnly ? (
            <p className="text-base text-text">{state.memo || '—'}</p>
          ) : (
            <TextInput
              value={state.memo}
              disabled={busy}
              onChange={(event) => {
                edit({ ...state, memo: event.target.value });
              }}
            />
          )}
        </Field>
      </div>

      {isCompact ? (
        // D-123: a seven-column entry grid only fits a phone by scrolling sideways, so on
        // compact each line is a stacked card instead. `LineCard` and `LineRow` share their
        // controls (`lineControls`), so the two presentations cannot drift.
        <ul aria-label={`${vocabulary.singular} lines`} className="flex flex-col gap-3">
          {state.lines.map((line, index) => (
            <LineCard key={line.key} {...lineProps(line, index)} />
          ))}
        </ul>
      ) : (
        <ResponsiveTable>
          <table className="w-full border-collapse">
            <caption className="sr-only">{vocabulary.singular} lines</caption>
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
                <th scope="col" className="p-1 font-medium">
                  Tax rate
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Unit price
                </th>
                <th scope="col" className="p-1 text-right font-medium">
                  Line total
                </th>
                <th scope="col" className="p-1 font-medium">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.lines.map((line, index) => (
                <LineRow key={line.key} {...lineProps(line, index)} />
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}

      {!readOnly && (
        <div>
          <Button
            disabled={busy}
            onClick={() => {
              edit({ ...state, lines: [...state.lines, blankLine()] });
            }}
          >
            Add line
          </Button>
        </div>
      )}

      <div
        role="status"
        className="flex flex-col gap-1 rounded-lg border border-border bg-surface-sunken p-3"
      >
        {priced && saved !== null ? (
          <>
            <div className="flex justify-between text-sm text-text-muted">
              <span>Net</span>
              <span className="font-mono tabular-nums text-text">
                {formatMinorUnits(saved.totals.net)}
              </span>
            </div>
            {saved.taxSummary.map((row) => (
              <div
                key={row.taxRateId ?? 'untaxed'}
                className="flex justify-between text-sm text-text-muted"
              >
                <span>
                  {row.taxRateName ?? 'Untaxed'}
                  {row.percentage === null ? '' : ` (${row.percentage}%)`}
                </span>
                <span className="font-mono tabular-nums text-text">
                  {formatMinorUnits(row.tax)}
                </span>
              </div>
            ))}
            <div className="flex justify-between text-sm text-text-muted">
              <span>Tax</span>
              <span className="font-mono tabular-nums text-text">
                {formatMinorUnits(saved.totals.tax)}
              </span>
            </div>
            <div className="flex justify-between border-t border-border pt-1 text-sm font-semibold text-text">
              <span>Total</span>
              <span className="font-mono tabular-nums">{formatMinorUnits(saved.totals.gross)}</span>
            </div>
          </>
        ) : (
          <p className="text-sm text-text-muted">
            Not priced yet. Tax is computed line by line by the server (D-35) — save the draft to
            see the totals.
          </p>
        )}
        {fieldErrors['lines'] !== undefined && <FieldError>{fieldErrors['lines']}</FieldError>}
        {problems.noLines && <FieldError>Add at least one line.</FieldError>}
        {problems.vendor && <FieldError>Choose the vendor this is from.</FieldError>}
      </div>

      {saved !== null && saved.allocations.length > 0 && (
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3">
          <p className="text-sm font-medium text-text">
            Applied against this {vocabulary.singular}
          </p>
          {saved.allocations.map((allocation) => (
            <p key={allocation.id} className="text-sm text-text-muted">
              <span className="font-mono text-text">
                {allocation.sourceNumber ?? allocation.targetNumber ?? '—'}
              </span>{' '}
              — {formatMinorUnits(allocation.amount)} on {allocation.date}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <span className="text-sm text-text-subtle">
          {readOnly
            ? 'Approved documents cannot be edited (D-38).'
            : dirty
              ? 'Unsaved changes'
              : 'All changes saved'}
        </span>

        <div className="flex-1" />

        {!readOnly && (
          <>
            <Button variant="danger" disabled={busy} onClick={() => setConfirmingDiscard(true)}>
              Discard
            </Button>
            <Button
              disabled={busy || !dirty}
              onClick={() => {
                void handleSave();
              }}
            >
              Save draft
            </Button>
            {/**
             * Separate and deliberate: this is the act that reaches the ledger. Disabled
             * while one is in flight, and carrying one key per document besides, so neither
             * a double click nor a retry after a refusal can post two journals.
             */}
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                void handleApprove();
              }}
            >
              {approveDocument.isPending ? 'Approving…' : `Approve ${vocabulary.singular}`}
            </Button>
          </>
        )}

        {readOnly && status !== 'void' && (
          <>
            {kind === 'vendor_credit' && (
              <Button disabled={busy} onClick={() => setAllocating(true)}>
                Apply to bills
              </Button>
            )}
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                setVoidMemo('');
                setVoidingDate(todayIsoDate());
              }}
            >
              Void {vocabulary.singular}
            </Button>
          </>
        )}
      </div>

      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent
          title={`Discard this ${vocabulary.singular}?`}
          description={
            'The draft and its lines are deleted. Nothing in the ledger changes, and no number ' +
            'is left unused — a document is numbered at approval, never before (D-36).'
          }
          footer={
            <>
              <Button onClick={() => setConfirmingDiscard(false)}>Keep editing</Button>
              <Button
                variant="danger"
                onClick={() => {
                  void handleDiscard();
                }}
              >
                Discard {vocabulary.singular}
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            This cannot be undone, and it does not need to be: nothing about this draft has reached
            the ledger.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog
        open={voidingDate !== null}
        onOpenChange={(open) => {
          if (!open) setVoidingDate(null);
        }}
      >
        <DialogContent
          title={`Void ${saved?.documentNumber ?? `this ${vocabulary.singular}`}?`}
          description={
            'Voiding posts a reversing journal and leaves the document, its number and its ' +
            'original journal visible. Nothing is deleted (D-16) — a voided document that ' +
            'vanished would make the gapless sequence a lie.'
          }
          footer={
            <>
              <Button onClick={() => setVoidingDate(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={busy || voidingDate === null}
                onClick={() => {
                  if (voidingDate !== null) void handleVoid(voidingDate);
                }}
              >
                Post the reversal
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Field
              hint={
                'The reversal has its own entry date and it must fall in an open period — the ' +
                'document’s own period is usually closed by the time anyone voids it.'
              }
            >
              <FieldLabel>Reversal date</FieldLabel>
              <TextInput
                type="date"
                value={voidingDate ?? ''}
                onChange={(event) => setVoidingDate(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <TextInput value={voidMemo} onChange={(event) => setVoidMemo(event.target.value)} />
            </Field>
          </div>
        </DialogContent>
      </Dialog>

      {kind === 'vendor_credit' && saved !== null && (
        <AllocateDialog
          open={allocating}
          onOpenChange={setAllocating}
          creditNumber={saved.documentNumber ?? ''}
          creditOutstanding={saved.settlement.outstanding}
          bills={vendorBills}
          isPending={applyCredit.isPending}
          error={applyCredit.error}
          onApply={(allocations) => {
            void handleApply(allocations);
          }}
        />
      )}
    </section>
  );
}
