import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import {
  api,
  expectNoContent,
  idempotencyHeader,
  newIdempotencyKey,
  presentApiError,
  unwrap,
} from '../../api';
import type { IdempotentVariables } from '../../api';
import {
  Button,
  Dialog,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  Select,
  TextInput,
} from '../../components';
import type { ComboboxOption } from '../../components';
import { BalanceIndicator } from './balance-indicator';
import { totalsOf } from './balance';
import { blankLine, patchFromState, stateFromDraft } from './draft-state';
import type { DraftEntryType, EditorLine, EditorState } from './draft-state';
import { idempotencyKeyFor, releaseIdempotencyKey } from './idempotency-keys';
import { LineRow } from './line-row';
import { journalEntryKeys } from './queries';
import type { JournalDraft, PostedJournal, ReferenceData, UpdateDraftRequest } from './queries';

const ENTRY_TYPE_OPTIONS: readonly { readonly value: DraftEntryType; readonly label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'adjusting', label: 'Adjusting' },
  { value: 'reclassifying', label: 'Reclassifying' },
];

/** Narrows the Select's `string` back to the classification union; anything else is standard. */
function toEntryType(value: string): DraftEntryType {
  return value === 'adjusting' || value === 'reclassifying' ? value : 'standard';
}

/**
 * The draft editor — the screen M2 is named for.
 *
 * ## The draft is the point
 *
 * D-16 keeps deletion impossible and declines reversal as the UX answer to a typo; D-19
 * makes a draft a different kind of thing rather than a weaker journal. Everything a
 * journal requires is nullable on a draft *deliberately*, because a draft is the state
 * of a form that is not finished. So this editor saves freely, discards freely, and
 * refuses nothing the server will decide at post: no arity rule, no balance rule, no
 * one-sidedness rule. The kernel checks all three together and answers as one
 * `validation_failed` naming `lines`, and a second copy here would drift from it.
 *
 * ## Post is a separate act, and it saves first
 *
 * `postDraft` posts what the *server* holds — no body, because a body would be a second
 * place to say what is being posted (`transport/routes/drafts.ts`). An editor that let
 * Post run against a stale stored draft would post an entry the user cannot see, so Post
 * flushes unsaved edits and then posts. Two writes, each with its own key: the save's is
 * minted per save because its fingerprint is the patch, and the post's is minted per
 * draft because its fingerprint is the draft id — see `idempotency-keys.ts`.
 */
export interface DraftEditorProps {
  readonly draft: JournalDraft;
  readonly reference: ReferenceData;
  readonly onPosted: (journal: PostedJournal) => void;
  readonly onDiscarded: () => void;
}

const POST_DRAFT = 'postDraft';

/** The sentinel `LineRow` maps back to `null`; see the note there. */
const NO_CONTACT: ComboboxOption = { value: '', label: 'No contact' };

export function DraftEditor({
  draft,
  reference,
  onPosted,
  onDiscarded,
}: DraftEditorProps): ReactElement {
  const queryClient = useQueryClient();

  const [state, setState] = useState<EditorState>(() => stateFromDraft(draft));
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  /**
   * The last refusal, held rather than derived from the mutations.
   *
   * Three mutations can fail and only the most recent attempt is the one the user is
   * looking at; reading `post.error ?? save.error` would keep showing a post failure
   * that a later successful save has already answered.
   */
  const [failure, setFailure] = useState<unknown>(null);

  const accountOptions = useMemo<ComboboxOption[]>(
    () =>
      reference.accounts.map((account) => ({
        value: account.id,
        label: account.name,
        detail: account.code,
        // An inactive account keeps every posting it carries and cannot be selected for
        // new ones. Listed and disabled rather than omitted, so a draft that already
        // names one still shows which account it is.
        disabled: !account.isActive,
      })),
    [reference.accounts],
  );

  const contactOptions = useMemo<ComboboxOption[]>(
    () => [
      NO_CONTACT,
      ...reference.contacts.map((contact) => ({
        value: contact.id,
        label: contact.displayName,
        ...(contact.code === null ? {} : { detail: contact.code }),
        disabled: !contact.isActive,
      })),
    ],
    [reference.contacts],
  );

  const totals = useMemo(() => totalsOf(state.lines), [state.lines]);

  const presented = failure === null ? null : presentApiError(failure);
  /**
   * Field messages arrive keyed by the dotted path the server's `ValidationIssue` uses,
   * and the indices in `lines.N.…` are indices into the draft's own line list — the same
   * order this table renders, because a save replaces the whole set in the order it was
   * sent. `lines` with no index is the set-level verdict (unbalanced, too few lines, no
   * value), which belongs next to the balancing indicator rather than on any one row.
   */
  const fieldErrors = presented?.fieldErrors ?? {};

  const saveDraft = useMutation({
    mutationFn: async (variables: IdempotentVariables<{ readonly patch: UpdateDraftRequest }>) =>
      unwrap(
        await api.PATCH('/v1/journal-drafts/{draftId}', {
          body: variables.patch,
          params: {
            path: { draftId: draft.id },
            header: idempotencyHeader(variables.idempotencyKey),
          },
        }),
      ),
  });

  const postDraft = useMutation({
    mutationFn: async (variables: { readonly idempotencyKey: string }) =>
      unwrap(
        await api.POST('/v1/journal-drafts/{draftId}/post', {
          params: {
            path: { draftId: draft.id },
            header: idempotencyHeader(variables.idempotencyKey),
          },
        }),
      ),
  });

  const discardDraft = useMutation({
    mutationFn: async (variables: { readonly idempotencyKey: string }) => {
      expectNoContent(
        await api.DELETE('/v1/journal-drafts/{draftId}', {
          params: {
            path: { draftId: draft.id },
            header: idempotencyHeader(variables.idempotencyKey),
          },
        }),
      );
    },
  });

  const busy = saveDraft.isPending || postDraft.isPending || discardDraft.isPending;

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

  function forgetDraft(): void {
    releaseIdempotencyKey(POST_DRAFT, draft.id);
    queryClient.removeQueries({ queryKey: journalEntryKeys.draft(draft.id) });
    void queryClient.invalidateQueries({ queryKey: journalEntryKeys.drafts });
  }

  async function save(): Promise<void> {
    const saved = await saveDraft.mutateAsync({
      patch: patchFromState(state),
      // Minted per save and not held against the draft: the claim fingerprints the
      // patch, so the *same* key with edited content is an `idempotency_key_conflict`.
      idempotencyKey: newIdempotencyKey(),
    });
    // Re-read from the response rather than keeping the local copy: the server settles
    // what a line actually stored — an amount typed against a side that was then cleared
    // comes back as neither — and the new lines carry the ids this table keys on.
    setState(stateFromDraft(saved));
    setDirty(false);
    queryClient.setQueryData(journalEntryKeys.draft(draft.id), saved);
    void queryClient.invalidateQueries({ queryKey: journalEntryKeys.drafts });
  }

  async function handleSave(): Promise<void> {
    setFailure(null);
    try {
      await save();
    } catch (error) {
      setFailure(error);
    }
  }

  async function handlePost(): Promise<void> {
    setFailure(null);
    try {
      if (dirty) await save();
      const journal = await postDraft.mutateAsync({
        idempotencyKey: idempotencyKeyFor(POST_DRAFT, draft.id),
      });
      forgetDraft();
      onPosted(journal);
    } catch (error) {
      // The draft is untouched: a refused post rolls back the whole transaction, so what
      // is on screen is still what is stored and Post remains the next thing to press.
      setFailure(error);
    }
  }

  async function handleDiscard(): Promise<void> {
    setFailure(null);
    setConfirmingDiscard(false);
    try {
      await discardDraft.mutateAsync({ idempotencyKey: newIdempotencyKey() });
      forgetDraft();
      onDiscarded();
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Journal entry draft">
      {presented !== null && (
        <ErrorBanner
          error={failure}
          onRetry={() => {
            void handlePost();
          }}
        />
      )}

      <div className="flex flex-wrap gap-4">
        <Field className="w-48" error={fieldErrors['entryDate']}>
          <FieldLabel>Entry date</FieldLabel>
          <TextInput
            type="date"
            value={state.entryDate}
            disabled={busy}
            onChange={(event) => {
              edit({ ...state, entryDate: event.target.value });
            }}
          />
        </Field>

        <Field className="w-48" error={fieldErrors['reference']}>
          <FieldLabel>Reference</FieldLabel>
          <TextInput
            value={state.reference}
            disabled={busy}
            onChange={(event) => {
              edit({ ...state, reference: event.target.value });
            }}
          />
        </Field>

        <Field className="min-w-64 flex-1" error={fieldErrors['memo']}>
          <FieldLabel>Description</FieldLabel>
          <TextInput
            value={state.memo}
            disabled={busy}
            onChange={(event) => {
              edit({ ...state, memo: event.target.value });
            }}
          />
        </Field>

        {/* The classification the posted journal carries (P, OB-194): an accountant flags
            an adjusting or reclassifying entry here, and the audit trail reads it back. */}
        <Field className="w-52" error={fieldErrors['entryType']}>
          <FieldLabel>Entry type</FieldLabel>
          <Select
            aria-label="Entry type"
            value={state.entryType}
            disabled={busy}
            options={ENTRY_TYPE_OPTIONS}
            onValueChange={(value) => {
              edit({ ...state, entryType: toEntryType(value) });
            }}
          />
        </Field>
      </div>

      <ResponsiveTable>
        <table className="w-full border-collapse">
          <caption className="sr-only">Journal lines</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="p-1 font-medium">
                Account
              </th>
              <th scope="col" className="p-1 font-medium">
                Contact
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Debit
              </th>
              <th scope="col" className="p-1 text-right font-medium">
                Credit
              </th>
              <th scope="col" className="p-1 font-medium">
                <span className="sr-only">Line details</span>
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
                reference={reference}
                accountOptions={accountOptions}
                contactOptions={contactOptions}
                fieldErrors={fieldErrors}
                expanded={expanded.has(line.key)}
                disabled={busy}
                onToggleDetail={() => {
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (!next.delete(line.key)) next.add(line.key);
                    return next;
                  });
                }}
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

      <BalanceIndicator totals={totals} linesError={fieldErrors['lines']} />

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <span className="text-sm text-text-subtle">
          {dirty ? 'Unsaved changes' : 'All changes saved'}
        </span>

        <div className="flex-1" />

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
         * Separate and deliberate: this is the act that reaches the ledger, and after it
         * the entry cannot be edited or deleted by anyone — the app user holds no
         * `UPDATE` or `DELETE` on `journals` at all (A6). Disabled while a post is in
         * flight, and carrying one key per draft besides, so neither a double click nor
         * a retry after a refusal can produce two journals.
         */}
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => {
            void handlePost();
          }}
        >
          {postDraft.isPending ? 'Posting…' : 'Post entry'}
        </Button>
      </div>

      <Dialog open={confirmingDiscard} onOpenChange={setConfirmingDiscard}>
        <DialogContent
          title="Discard this draft?"
          description={
            'The draft and its lines are deleted. Nothing in the ledger changes, because ' +
            'nothing about this draft ever reached it.'
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
                Discard draft
              </Button>
            </>
          }
        >
          <p className="text-sm text-text-muted">
            This cannot be undone, and it does not need to be: a draft has not been posted.
          </p>
        </DialogContent>
      </Dialog>
    </section>
  );
}
