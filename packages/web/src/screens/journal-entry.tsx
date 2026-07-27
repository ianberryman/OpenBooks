import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';

import { api, idempotencyHeader, newIdempotencyKey, unwrap } from '../api';
import { Button, ErrorBanner } from '../components';
import { DraftEditor } from './journal-entry/draft-editor';
import { todayIsoDate } from './journal-entry/draft-state';
import { PostedEntry } from './journal-entry/posted-entry';
import { journalEntryKeys, useDraft, useDrafts, useReferenceData } from './journal-entry/queries';
import type { JournalDraftSummary, PostedJournal } from './journal-entry/queries';

/**
 * OB-051 — the journal entry screen.
 *
 * Three states, and the boundary between the first two is the milestone's argument
 * (D-16, D-19): a **draft** is freely editable and freely discarded because it has not
 * reached the ledger, and a **posted** entry is immutable because it has. Posting is the
 * single act that moves an entry across that line, and it is deliberate — a separate
 * button, carrying one idempotency key per draft, so that clicking it twice cannot
 * produce two journals. See `draft-editor.tsx` and `idempotency-keys.ts`.
 *
 * The screen holds its own selection rather than reading a route parameter. Routing is
 * another ticket's file; keeping the draft id in local state means this screen works
 * wherever it is mounted and adds no second place — outside the query cache — where
 * fetched data could survive an org switch (`src/query/client.ts`).
 */
type View =
  | { readonly kind: 'drafts' }
  | { readonly kind: 'draft'; readonly draftId: string }
  | { readonly kind: 'posted'; readonly journal: PostedJournal };

function DraftList({
  drafts,
  onOpen,
}: {
  readonly drafts: readonly JournalDraftSummary[];
  readonly onOpen: (draftId: string) => void;
}): ReactElement {
  if (drafts.length === 0) {
    return (
      <p className="text-text-muted">
        No drafts. Start a new entry — nothing is required to save one, and nothing it holds reaches
        the ledger until it is posted.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {drafts.map((draft) => (
        <li key={draft.id}>
          <button
            type="button"
            onClick={() => onOpen(draft.id)}
            className="flex w-full items-baseline gap-4 rounded-lg border border-border bg-surface p-3 text-left hover:bg-surface-hover"
          >
            <span className="font-mono text-sm text-text">{draft.entryDate ?? 'No date'}</span>
            <span className="min-w-0 flex-1 truncate text-text">{draft.memo ?? 'Untitled'}</span>
            {draft.reference !== null && (
              <span className="font-mono text-xs text-text-subtle">{draft.reference}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function JournalEntryScreen(): ReactElement {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: 'drafts' });

  const reference = useReferenceData();
  const drafts = useDrafts();
  const draft = useDraft(view.kind === 'draft' ? view.draftId : null);

  const createDraft = useMutation({
    mutationFn: async (variables: { readonly idempotencyKey: string }) =>
      unwrap(
        await api.POST('/v1/journal-drafts', {
          /**
           * Dated today, and that is a convenience rather than a rule: the date decides
           * which fiscal period the entry lands in, and it is resolved at post rather
           * than at draft time (D-19), so pre-filling it costs nothing and saves the
           * commonest keystroke. Everything else is left empty, because a form that
           * cannot be saved until it is already correct is not a draft.
           */
          body: { entryDate: todayIsoDate() },
          params: { header: idempotencyHeader(variables.idempotencyKey) },
        }),
      ),
  });

  async function handleNewEntry(): Promise<void> {
    const created = await createDraft.mutateAsync({ idempotencyKey: newIdempotencyKey() });
    queryClient.setQueryData(journalEntryKeys.draft(created.id), created);
    void queryClient.invalidateQueries({ queryKey: journalEntryKeys.drafts });
    setView({ kind: 'draft', draftId: created.id });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold text-text">Journal entry</h1>
        <div className="flex-1" />
        {view.kind !== 'drafts' && (
          <Button onClick={() => setView({ kind: 'drafts' })}>Drafts</Button>
        )}
        <Button
          variant="primary"
          disabled={createDraft.isPending}
          onClick={() => {
            void handleNewEntry();
          }}
        >
          New entry
        </Button>
      </div>

      {createDraft.error !== null && <ErrorBanner error={createDraft.error} />}

      {reference.error != null && (
        <ErrorBanner error={reference.error} onRetry={reference.refetch} />
      )}

      {reference.data === null ? (
        <p className="text-text-subtle">Loading accounts, contacts and dimensions…</p>
      ) : view.kind === 'posted' ? (
        <PostedEntry
          journal={view.journal}
          reference={reference.data}
          onReversed={(reversal) => setView({ kind: 'posted', journal: reversal })}
          onBackToDrafts={() => setView({ kind: 'drafts' })}
        />
      ) : view.kind === 'draft' ? (
        draft.error != null ? (
          <ErrorBanner error={draft.error} onRetry={draft.refetch} />
        ) : draft.draft === null ? (
          <p className="text-text-subtle">Loading the draft…</p>
        ) : (
          <DraftEditor
            /**
             * Keyed by the draft, so switching drafts remounts the editor rather than
             * merging one entry's rows into another's. The editor owns its lines after
             * mount; without the key, a background refetch of a *different* draft would
             * land in the form the user is typing into.
             */
            key={draft.draft.id}
            draft={draft.draft}
            reference={reference.data}
            onPosted={(journal) => setView({ kind: 'posted', journal })}
            onDiscarded={() => setView({ kind: 'drafts' })}
          />
        )
      ) : drafts.error != null ? (
        <ErrorBanner error={drafts.error} onRetry={drafts.refetch} />
      ) : drafts.isPending ? (
        <p className="text-text-subtle">Loading drafts…</p>
      ) : (
        <DraftList
          drafts={drafts.drafts}
          onOpen={(draftId) => setView({ kind: 'draft', draftId })}
        />
      )}
    </div>
  );
}
