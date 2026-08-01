import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';

import { ApiError } from '../api';
import { Button, ErrorBanner } from '../components';
import { PostedEntry } from './journal-entry/posted-entry';
import { useReferenceData } from './journal-entry/queries';
import { JournalsList } from './journals/journals-list';
import { useJournal } from './journals/queries';
import type { PostedJournal } from './journals/queries';

/**
 * Posted journals (OB-236) — a list of every entry the ledger holds, deep-linkable to
 * one entry at a time.
 *
 * ## The list and a journal are two routes, not one piece of local state
 *
 * `sales.tsx`'s shape: `/journals` is the list and `/journals/:journalId` is one open
 * journal, routed rather than held in `useState`, so a journal is a link someone can
 * send, a page the browser's Back button returns from, and a URL that survives a
 * refresh — the same reasons OB-068 gave for invoices.
 *
 * ## The detail route renders the same component the journal-entry screen does
 *
 * `journal-entry/posted-entry.tsx`'s `<PostedEntry>` already renders exactly what a
 * posted journal is and carries the one action that may still be taken on one — Reverse
 * (D-02, D-16). A journal reached from this list is not a different kind of journal, so
 * this route fetches it and reference data and hands both to the same component the
 * journal-entry screen posts into, rather than a second read-only rendering that could
 * drift from the first.
 */
export function journalPath(journalId: string): string {
  return `/journals/${journalId}`;
}

export function JournalsScreen(): ReactElement {
  return (
    <Routes>
      <Route index element={<JournalsListRoute />} />
      <Route path=":journalId" element={<JournalDetailRoute />} />
      {/* A stray journals path is the list, not a 404 — mirrors sales.tsx. */}
      <Route path="*" element={<Navigate to="/journals" replace />} />
    </Routes>
  );
}

function JournalsListRoute(): ReactElement {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold text-text">Journals</h1>
        <p className="text-text-muted">Every entry posted to the ledger, oldest first.</p>
      </div>

      <JournalsList onOpen={(journalId) => void navigate(journalPath(journalId))} />
    </div>
  );
}

/**
 * One journal, addressed by the URL.
 *
 * `onReversed` navigates to the reversal's own URL rather than swapping the journal held
 * in place: a reversal is a distinct posted journal with its own id (D-02), so landing
 * on its URL keeps the address bar naming what is actually on screen — the same move
 * `sales.tsx`'s `DocumentRoute` makes after Approve. `onBackToDrafts` is `<PostedEntry>`'s
 * prop name from the journal-entry screen it was built for; here it is simply "back to
 * the list" — the component's contract is not this ticket's to rename.
 */
function JournalDetailRoute(): ReactElement {
  const navigate = useNavigate();
  const { journalId } = useParams();
  const id = journalId ?? null;

  const reference = useReferenceData();
  const opened = useJournal(id);

  function toList(): void {
    void navigate('/journals');
  }

  if (reference.error != null) {
    return <ErrorBanner error={reference.error} onRetry={reference.refetch} />;
  }
  if (reference.data === null) {
    return <p className="text-text-subtle">Loading accounts, contacts and dimensions…</p>;
  }

  // A cross-org read is indistinguishable from a nonexistent one (A7): the service
  // answers 404 either way, and this is the one branch that reads as "not found" rather
  // than a retryable failure.
  if (opened.error instanceof ApiError && opened.error.status === 404) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-6">
        <p className="text-base font-medium text-text">This journal was not found.</p>
        <Button onClick={toList}>Back to journals</Button>
      </div>
    );
  }
  if (opened.error != null) {
    return <ErrorBanner error={opened.error} onRetry={opened.refetch} />;
  }
  if (opened.journal === null) {
    return <p className="text-text-subtle">Loading the journal…</p>;
  }

  return (
    <PostedEntry
      key={opened.journal.journalId}
      journal={opened.journal}
      reference={reference.data}
      onReversed={(reversal: PostedJournal) => void navigate(journalPath(reversal.journalId))}
      onBackToDrafts={toList}
    />
  );
}
