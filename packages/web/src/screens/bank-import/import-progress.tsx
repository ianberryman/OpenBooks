import type { ReactElement } from 'react';

import { Button, ErrorBanner } from '../../components';
import { useStatementImport } from './queries';

/**
 * The async import made visible: queued → processing → complete/failed (D-47, D-49).
 *
 * Start-import returned immediately with a queued handle; this polls it (`useStatementImport`)
 * and shows one of three things — a spinner-less "still working" while the worker parses,
 * the E1 counts on completion, or the reason on failure. The parse never partially imports
 * (E1), so there is no in-between state to render: a failure means nothing was written and
 * the file can simply be uploaded again.
 */
export function ImportProgress({
  importId,
  onDone,
  onImportAnother,
}: {
  readonly importId: string;
  readonly onDone: () => void;
  readonly onImportAnother: () => void;
}): ReactElement {
  const poll = useStatementImport(importId);

  if (poll.isError) {
    return (
      <ErrorBanner
        error={poll.error}
        onRetry={() => {
          void poll.refetch();
        }}
      />
    );
  }

  const status = poll.data?.status;

  if (status === undefined || status === 'queued' || status === 'processing') {
    return (
      <div
        role="status"
        className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 text-sm text-text-muted"
      >
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-border border-t-accent"
        />
        Importing the statement… this runs in the background and updates here when it finishes.
      </div>
    );
  }

  if (status === 'failed') {
    return (
      <div className="flex flex-col gap-3">
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-danger-border bg-danger-soft p-3"
        >
          <p className="text-sm font-semibold text-danger-text">
            The import could not be completed
          </p>
          <p className="text-sm text-text-muted">
            {poll.data?.failureReason ?? 'The file could not be read.'}
          </p>
          <p className="text-xs text-text-subtle">
            Nothing was imported — the parse is all-or-nothing (E1). Fix the file or the mapping and
            upload it again.
          </p>
        </div>
        <div>
          <Button onClick={onImportAnother}>Start over</Button>
        </div>
      </div>
    );
  }

  // Complete. `result` is present exactly when `status` is `complete` (the wire refinement).
  const result = poll.data?.result ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 rounded-lg border border-success-border bg-success-soft p-3">
        <p className="text-sm font-semibold text-success-text">Statement imported</p>
        <p className="text-sm text-text">
          {result === null
            ? 'The import completed.'
            : `${result.linesImported} imported, ${result.linesDuplicate} already present` +
              ` (${result.linesRead} read).`}
        </p>
        <p className="text-xs text-text-subtle">
          Already-present rows were skipped, not doubled — that is the ordinary outcome of an
          overlapping upload (E1).
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" onClick={onImportAnother}>
          Import another file
        </Button>
        <Button onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
