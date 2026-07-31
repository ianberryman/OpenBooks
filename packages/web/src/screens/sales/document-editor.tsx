import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { newIdempotencyKey, presentApiError } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  Field,
  FieldLabel,
  ResponsiveTable,
  Select,
  TextInput,
} from '../../components';
import type { ComboboxOption, SelectOption } from '../../components';
import { blankLine, patchFromState, stateFromDocument } from './document-state';
import type { EditorLine, EditorState } from './document-state';
import { APPROVE_DOCUMENT, idempotencyKeyFor, releaseIdempotencyKey } from './intent-keys';
import { LineRow, NO_TAX_RATE } from './line-row';
import { apiFor, salesKeys } from './queries';
import type {
  SalesDocument,
  SalesDocumentKind,
  SalesReferenceData,
  TaxMode,
  UpdateDocumentBody,
} from './queries';
import { Refusal, preconditionToken } from './refusal';
import { TotalsPanel } from './totals';
import {
  TAX_MODE_EXPLANATIONS,
  TAX_MODE_LABELS,
  lifecycleSummary,
  vocabularyFor,
} from './vocabulary';

/**
 * The draft editor, and the button that ends the draft (OB-068; ROADMAP D-35, D-38).
 *
 * ## Approve is the line this screen is built around
 *
 * Before it, a document is editable and discardable exactly as a journal draft is (D-16,
 * D-19), and it holds **no number** — a number reserved by a draft that was then discarded
 * would leave a gap, and a gap in a document series is indistinguishable from a deleted
 * document. After it, the ledger has been told: the number is allocated, a balanced
 * journal is posted, and the only corrections left are a credit note or a void.
 *
 * That is why Approve is a confirmed, separate act carrying **one key per document**
 * rather than one per click (`intent-keys.ts`), and why it is `POST …/approve` rather than
 * a patch of `status`: status is derived from the journals and the allocations on every
 * read (D-38), so there is no field to write and the API publishes none.
 *
 * ## Approving saves first
 *
 * `approve` takes no body — it approves what the *server* holds, and a body would be a
 * second place to say what is being approved. An editor that let Approve run against a
 * stale stored draft would post a document the user cannot see, so unsaved edits are
 * flushed and then the approval is sent. Two writes, two keys, minted differently and for
 * stated reasons: the save's fingerprint is the patch, the approval's is the document id.
 *
 * ## Nothing here computes tax
 *
 * `taxMode` decides what `unitAmount` *means* (D-35), so changing it reprices the whole
 * document rather than converting the prices already typed — confirmed rather than done
 * silently, because the totals move and nothing the user typed changed. The repricing is
 * the server's, on save; this file sends inputs and reads figures back.
 */
export interface DocumentEditorProps {
  readonly document: SalesDocument;
  readonly kind: SalesDocumentKind;
  readonly reference: SalesReferenceData;
  readonly onApproved: (document: SalesDocument) => void;
  readonly onDiscarded: () => void;
}

const TAX_MODE_OPTIONS: readonly SelectOption[] = [
  { value: 'exclusive', label: TAX_MODE_LABELS.exclusive },
  { value: 'inclusive', label: TAX_MODE_LABELS.inclusive },
];

function isTaxMode(value: string): value is TaxMode {
  return value === 'exclusive' || value === 'inclusive';
}

export function DocumentEditor({
  document,
  kind,
  reference,
  onApproved,
  onDiscarded,
}: DocumentEditorProps): ReactElement {
  const queryClient = useQueryClient();
  const documentApi = apiFor(kind);
  const words = vocabularyFor(kind);

  const [state, setState] = useState<EditorState>(() => stateFromDocument(document));
  const [saved, setSaved] = useState<SalesDocument>(document);
  const [dirty, setDirty] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'discard' | null>(null);
  const [repricing, setRepricing] = useState<TaxMode | null>(null);
  /**
   * The last refusal, held rather than derived from the three mutations: only the most
   * recent attempt is the one the user is looking at, and reading `approve.error ??
   * save.error` would keep showing an approval failure a later successful save answered.
   */
  const [failure, setFailure] = useState<unknown>(null);

  const contactOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.contacts.map((contact) => ({
        value: contact.id,
        label: contact.displayName,
        ...(contact.code === null ? {} : { detail: contact.code }),
        // Archived contacts are listed and disabled rather than omitted, so a draft that
        // already names one still shows which customer it is for.
        disabled: !contact.isActive && contact.id !== state.contactId,
      })),
    [reference.contacts, state.contactId],
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

  const taxRateOptions = useMemo<ComboboxOption[]>(
    () => [
      NO_TAX_RATE,
      ...reference.taxRates.map((rate) => ({
        value: rate.id,
        label: rate.name,
        detail: `${rate.percentage}%`,
        // An archived rate stays on every document that used it and is not offered for a
        // new line — the only form of removal available to a rate a posted document names.
        disabled: !rate.isActive,
      })),
    ],
    [reference.taxRates],
  );

  const save = useMutation({
    mutationFn: async (variables: {
      readonly patch: UpdateDocumentBody;
      readonly idempotencyKey: string;
    }) => documentApi.update(document.id, variables.patch, variables.idempotencyKey),
  });

  const approve = useMutation({
    mutationFn: async (variables: { readonly idempotencyKey: string }) =>
      documentApi.approve(document.id, variables.idempotencyKey),
  });

  const discard = useMutation({
    mutationFn: async (variables: { readonly idempotencyKey: string }) =>
      documentApi.discard(document.id, variables.idempotencyKey),
  });

  const busy = save.isPending || approve.isPending || discard.isPending;

  const presented = failure === null ? null : presentApiError(failure);
  const fieldErrors = presented?.fieldErrors ?? {};
  const token = preconditionToken(failure);

  function edit(next: EditorState): void {
    setState(next);
    setDirty(true);
  }

  function editLine(line: EditorLine): void {
    edit({
      ...state,
      lines: state.lines.map((existing) => (existing.key === line.key ? line : existing)),
    });
  }

  async function persist(): Promise<SalesDocument> {
    const result = await save.mutateAsync({
      patch: patchFromState(state, kind),
      // Minted per save and never held against the document: the claim fingerprints the
      // patch, so the *same* key with edited content is an `idempotency_key_conflict`.
      idempotencyKey: newIdempotencyKey(),
    });
    // Re-read from the response rather than keeping the local copy. This is where the
    // repricing arrives: the server settles what each line's net, tax and gross are, and
    // the new lines carry the ids this table keys on.
    setState(stateFromDocument(result));
    setSaved(result);
    setDirty(false);
    queryClient.setQueryData(salesKeys.document(kind, document.id), result);
    void queryClient.invalidateQueries({ queryKey: salesKeys.list(kind) });
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
      if (dirty) await persist();
      const approved = await approve.mutateAsync({
        idempotencyKey: idempotencyKeyFor(APPROVE_DOCUMENT, document.id),
      });
      // The intent is spent: this document has a journal now, and a further attempt with
      // the same key would be a replay of an outcome that has already been rendered.
      releaseIdempotencyKey(APPROVE_DOCUMENT, document.id);
      queryClient.setQueryData(salesKeys.document(kind, document.id), approved);
      void queryClient.invalidateQueries({ queryKey: salesKeys.list(kind) });
      onApproved(approved);
    } catch (error) {
      // The document is untouched: a refused approval rolls back the whole transaction,
      // so it is still a draft, still holds no number, and Approve is still the next
      // thing to press — with the key it already had.
      setFailure(error);
    }
  }

  async function handleDiscard(): Promise<void> {
    setFailure(null);
    setConfirming(null);
    try {
      await discard.mutateAsync({ idempotencyKey: newIdempotencyKey() });
      releaseIdempotencyKey(APPROVE_DOCUMENT, document.id);
      queryClient.removeQueries({ queryKey: salesKeys.document(kind, document.id) });
      void queryClient.invalidateQueries({ queryKey: salesKeys.list(kind) });
      onDiscarded();
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label={`${words.singular} draft`}>
      <p className="text-sm text-text-muted">
        {lifecycleSummary('draft', kind, words.outstandingLabel)}
      </p>

      {presented !== null && (
        <Refusal error={failure}>
          {token === 'receivable_control_account_not_set' ||
          token === 'receivable_control_account_unusable' ? (
            <p className="text-sm text-text-muted">
              Approving posts a journal against the organization’s receivables control account, and
              this organization has not nominated a usable one. Set it in Settings, then approve
              again — nothing about this draft was changed.
            </p>
          ) : token === 'document_approved' ? (
            <p className="text-sm text-text-muted">
              This {words.singular.toLowerCase()} has been approved since this form was opened, so
              it can no longer be edited. Reload it to see what it now is; the correction after
              approval is a credit note or a void.
            </p>
          ) : undefined}
        </Refusal>
      )}

      <div className="flex flex-wrap gap-4">
        <Field className="min-w-64 flex-1" error={fieldErrors['contactId']}>
          <FieldLabel>Customer</FieldLabel>
          <Combobox
            options={contactOptions}
            value={state.contactId}
            disabled={busy}
            placeholder="Search contacts…"
            onValueChange={(value) => {
              edit({ ...state, contactId: value });
            }}
          />
        </Field>

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

        {/* Credit notes carry no due date: nothing about one falls due, and aging never
            ages one (D-39). The field is absent rather than disabled, because a greyed
            box invites the question of what would go in it. */}
        {kind === 'invoice' && (
          <Field
            className="w-44"
            error={fieldErrors['dueDate']}
            hint="Aging measures from here, not from the issue date."
          >
            <FieldLabel>Due date</FieldLabel>
            <TextInput
              type="date"
              value={state.dueDate}
              disabled={busy}
              onChange={(event) => {
                edit({ ...state, dueDate: event.target.value });
              }}
            />
          </Field>
        )}

        <Field className="w-56" error={fieldErrors['reference']} hint={words.referenceHint}>
          <FieldLabel>Reference</FieldLabel>
          <TextInput
            value={state.reference}
            disabled={busy}
            onChange={(event) => {
              edit({ ...state, reference: event.target.value });
            }}
          />
        </Field>
      </div>

      <Field className="max-w-md" hint={TAX_MODE_EXPLANATIONS[state.taxMode]}>
        <FieldLabel>Tax on prices</FieldLabel>
        <Select
          options={TAX_MODE_OPTIONS}
          value={state.taxMode}
          disabled={busy}
          onValueChange={(value) => {
            if (!isTaxMode(value) || value === state.taxMode) return;
            /**
             * Confirmed rather than applied, whenever there is anything to reprice. The
             * flag decides what every `unitAmount` already entered *means*, so switching
             * it does not convert the prices — it reads the same numbers the other way,
             * and the totals move without anything the user typed having changed (D-35).
             */
            if (state.lines.some((line) => line.unitAmount !== null)) {
              setRepricing(value);
              return;
            }
            edit({ ...state, taxMode: value });
          }}
        />
      </Field>

      <Field className="max-w-2xl" error={fieldErrors['memo']}>
        <FieldLabel>Memo</FieldLabel>
        <TextInput
          value={state.memo}
          disabled={busy}
          onChange={(event) => {
            edit({ ...state, memo: event.target.value });
          }}
        />
      </Field>

      <ResponsiveTable>
        <table className="w-full border-collapse">
          <caption className="sr-only">{words.singular} lines</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="p-1 font-medium">
                Description
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Qty
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                {state.taxMode === 'inclusive'
                  ? 'Unit price (incl. tax)'
                  : 'Unit price (excl. tax)'}
              </th>
              <th scope="col" className="p-1 font-medium">
                Account
              </th>
              <th scope="col" className="p-1 font-medium">
                Tax rate
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Net
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Tax
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Total
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
                taxRateOptions={taxRateOptions}
                fieldErrors={fieldErrors}
                stale={dirty}
                disabled={busy}
                onChange={editLine}
                onRemove={() => {
                  edit({ ...state, lines: state.lines.filter((it) => it.key !== line.key) });
                }}
              />
            ))}
          </tbody>
        </table>
      </ResponsiveTable>

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

      <div className="flex justify-end">
        <TotalsPanel
          document={saved}
          reference={reference}
          outstandingLabel={words.outstandingLabel}
          stale={dirty}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <span className="text-sm text-text-subtle">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>

        <div className="flex-1" />

        <Button variant="danger" disabled={busy} onClick={() => setConfirming('discard')}>
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
         * Disabled while any write is in flight, and carrying one key per document
         * besides (`intent-keys.ts`), so neither a double click nor a retry after a
         * refusal can allocate two numbers or post two journals.
         */}
        <Button variant="primary" disabled={busy} onClick={() => setConfirming('approve')}>
          {approve.isPending ? 'Approving…' : 'Approve'}
        </Button>
      </div>

      <Dialog
        open={confirming === 'approve'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <DialogContent
          title={`Approve this ${words.singular.toLowerCase()}?`}
          description={
            'Approving posts its journal to the ledger and allocates its number. This is the one ' +
            'step that cannot be undone.'
          }
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Keep editing</Button>
              <Button
                variant="primary"
                onClick={() => {
                  void handleApprove();
                }}
              >
                Approve
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            After this it can no longer be edited or discarded. The corrections available are a{' '}
            {kind === 'invoice' ? 'credit note or a void' : 'void'} — both of which leave this
            document, its number and its journal visible, because nothing here is ever deleted.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirming === 'discard'}
        onOpenChange={(next) => {
          if (!next) setConfirming(null);
        }}
      >
        <DialogContent
          title={`Discard this ${words.singular.toLowerCase()}?`}
          description="The draft and its lines are deleted."
          footer={
            <>
              <Button onClick={() => setConfirming(null)}>Keep editing</Button>
              <Button
                variant="danger"
                onClick={() => {
                  void handleDiscard();
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            Nothing in the ledger changes, because nothing about this draft ever reached it — and no
            number is freed, because none was allocated. That is why a draft can be deleted outright
            while an approved document can only be voided.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog
        open={repricing !== null}
        onOpenChange={(next) => {
          if (!next) setRepricing(null);
        }}
      >
        <DialogContent
          title="Reprice this document?"
          description={
            repricing === null
              ? ''
              : `Switching to “${TAX_MODE_LABELS[repricing]}” changes what every unit price on ` +
                'this document means.'
          }
          footer={
            <>
              <Button onClick={() => setRepricing(null)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  if (repricing !== null) edit({ ...state, taxMode: repricing });
                  setRepricing(null);
                }}
              >
                Reprice
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            {repricing === null ? '' : TAX_MODE_EXPLANATIONS[repricing]} The prices you typed are
            not converted — they are read the other way, so the totals will move even though nothing
            you entered has changed. The new figures are computed by the server when the draft is
            saved.
          </p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
