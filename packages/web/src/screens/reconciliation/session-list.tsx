import type { ReactElement } from 'react';
import { useMemo } from 'react';

import { Button, ErrorBanner, formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import type { ReconciliationSessionSummary, SessionFilters } from './queries';
import { useSessionList } from './queries';

/**
 * The sessions for the chosen bank account, newest by end date (OB-087).
 *
 * Each row carries enough to answer "which reconciliation is this and did it balance"
 * without opening it: the window it covers, whether it is open or finalised, and its
 * difference — because a list that could not show whether each one balanced would be
 * unusable (the `ReconciliationSessionSummary` note in the schema). The balances are the
 * server's, computed on read (D-46); nothing here recomputes them.
 */

function isZeroDifference(summary: ReconciliationSessionSummary): boolean {
  return summary.balances.difference === '0' || summary.balances.difference === '-0';
}

export function SessionList({
  filters,
  selectedId,
  onSelect,
}: {
  readonly filters: SessionFilters;
  readonly selectedId: string | null;
  readonly onSelect: (sessionId: string) => void;
}): ReactElement {
  const list = useSessionList(filters);
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);

  if (filters.bankAccountId === null) {
    return (
      <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
        Choose a bank account to see its reconciliations.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {list.isPending && <p className="text-text-muted">Loading reconciliations…</p>}

      {list.isError && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      {list.isSuccess && rows.length === 0 && (
        <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
          No reconciliations for this account yet. Open one against a statement to start.
        </p>
      )}

      {rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              selected={session.id === selectedId}
              onOpen={() => {
                onSelect(session.id);
              }}
            />
          ))}
        </ul>
      )}

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
    </div>
  );
}

function SessionRow({
  session,
  selected,
  onOpen,
}: {
  readonly session: ReconciliationSessionSummary;
  readonly selected: boolean;
  readonly onOpen: () => void;
}): ReactElement {
  const finalised = session.state === 'finalised';
  const balanced = isZeroDifference(session);

  return (
    <li>
      <button
        type="button"
        aria-label={`Open the reconciliation to ${session.endDate}`}
        aria-pressed={selected}
        onClick={onOpen}
        className={cx(
          'flex w-full flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors',
          selected
            ? 'border-border-strong bg-surface-selected'
            : 'border-border bg-surface hover:bg-surface-hover',
        )}
      >
        <div className="flex flex-col">
          <span className="font-medium text-text">To {session.endDate}</span>
          <span className="text-xs text-text-subtle">
            {session.startDate} to {session.endDate}
            {session.unclearedLineCount > 0
              ? ` · ${String(session.unclearedLineCount)} uncleared`
              : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={cx(
              'font-mono text-sm tabular-nums',
              balanced ? 'text-success-text' : 'text-warning-text',
            )}
          >
            {balanced ? 'Balanced' : `Off by ${formatMinorUnits(session.balances.difference)}`}
          </span>
          <span
            className={cx(
              'rounded-full border px-2.5 py-0.5 text-xs font-medium',
              finalised
                ? 'border-success-border bg-success-soft text-success-text'
                : 'border-border bg-surface-sunken text-text-muted',
            )}
          >
            {finalised ? 'Finalised' : 'Open'}
          </span>
        </div>
      </button>
    </li>
  );
}
