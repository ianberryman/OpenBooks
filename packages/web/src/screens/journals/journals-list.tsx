import type { ReactElement } from 'react';

import { ErrorBanner, Pill, ResponsiveTable } from '../../components';
import { useIsCompact } from '../../lib/use-viewport';
import { useJournalsList } from './queries';
import type { JournalSummary } from './queries';

/**
 * The posted-journals list (OB-236). `document-list.tsx`'s shape: a `<ResponsiveTable>`
 * desktop table that collapses to a stack of cards below `md` (D-123), with each row or
 * card opening the journal it names.
 *
 * There is no filter and no summary card here, by decision — the list is a way to reach
 * a specific entry (usually by date or memo, scanned by eye), not a report; the trial
 * balance and the audit report already cover the aggregate view.
 *
 * `source` is read back verbatim rather than being a closed set the client re-labels
 * beyond "Manual"/"Reversal" — `journals.ts`'s route documents only that it is a string,
 * so an unrecognised value (a future source the server adds) is shown as-is rather than
 * hidden behind a label this file does not know.
 */
export interface JournalsListProps {
  readonly onOpen: (journalId: string) => void;
}

const KNOWN_SOURCE_LABELS: Readonly<Record<string, string>> = {
  manual: 'Manual',
  reversal: 'Reversal',
};

function sourceLabel(source: string): string {
  return KNOWN_SOURCE_LABELS[source] ?? source;
}

/** A local, browser-formatted rendering of the posted instant. Not a report figure —
 * `postedAt` is when the write happened, shown for orientation, not for arithmetic. */
function formatPostedAt(iso: string): string {
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

export function JournalsList({ onOpen }: JournalsListProps): ReactElement {
  const list = useJournalsList();
  const isCompact = useIsCompact();

  if (list.error != null) {
    return <ErrorBanner error={list.error} onRetry={list.refetch} />;
  }
  if (list.isPending) {
    return <p className="text-text-subtle">Loading journals…</p>;
  }
  if (list.items.length === 0) {
    return <p className="text-text-muted">No journals have been posted yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {isCompact ? (
        <ul className="flex flex-col gap-3" aria-label="Posted journals">
          {list.items.map((journal) => (
            <JournalCard key={journal.journalId} journal={journal} onOpen={onOpen} />
          ))}
        </ul>
      ) : (
        <ResponsiveTable>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Posted journals</caption>
            <thead>
              <tr className="text-left text-xs text-text-subtle">
                <th scope="col" className="p-2 font-medium">
                  Entry #
                </th>
                <th scope="col" className="p-2 font-medium">
                  Date
                </th>
                <th scope="col" className="p-2 font-medium">
                  Memo
                </th>
                <th scope="col" className="p-2 font-medium">
                  Source
                </th>
                <th scope="col" className="p-2 font-medium">
                  Posted
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((journal) => (
                <tr
                  key={journal.journalId}
                  className="border-t border-border hover:bg-surface-hover"
                >
                  <td className="p-2">
                    <button
                      type="button"
                      onClick={() => onOpen(journal.journalId)}
                      className="rounded-sm font-mono text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
                    >
                      {journal.sequenceNumber}
                    </button>
                  </td>
                  <td className="p-2 font-mono text-text-muted">{journal.date}</td>
                  <td className="min-w-0 max-w-xs truncate p-2 text-text">
                    {journal.memo ?? '—'}
                  </td>
                  <td className="p-2">
                    <Pill tone={journal.reversesJournalId !== null ? 'accent' : 'neutral'}>
                      {sourceLabel(journal.source)}
                    </Pill>
                  </td>
                  <td className="p-2 font-mono text-text-muted">
                    {formatPostedAt(journal.postedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}

      {list.truncated && (
        <p className="text-xs text-text-subtle">
          Showing the first page. Journals are listed oldest first — the most recent entries are
          on a later page.
        </p>
      )}
    </div>
  );
}

function JournalCard({
  journal,
  onOpen,
}: {
  readonly journal: JournalSummary;
  readonly onOpen: (journalId: string) => void;
}): ReactElement {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(journal.journalId)}
        className="flex w-full flex-col gap-3 rounded-lg border border-border bg-surface p-4 text-left hover:bg-surface-hover"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-lg font-semibold text-text">{journal.memo ?? 'Untitled'}</p>
            <p className="truncate font-mono text-sm text-text-subtle">
              #{journal.sequenceNumber}
            </p>
          </div>
          <Pill tone={journal.reversesJournalId !== null ? 'accent' : 'neutral'}>
            {sourceLabel(journal.source)}
          </Pill>
        </div>

        <div className="flex items-end justify-between gap-3 border-t border-border pt-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Date</p>
            <p className="mt-0.5 font-mono text-sm text-text">{journal.date}</p>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium uppercase tracking-wide text-text-subtle">Posted</p>
            <p className="mt-0.5 font-mono text-sm text-text-muted">
              {formatPostedAt(journal.postedAt)}
            </p>
          </div>
        </div>
      </button>
    </li>
  );
}
