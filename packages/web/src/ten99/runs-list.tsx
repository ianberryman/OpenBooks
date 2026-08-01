import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Ten99Run, Ten99RunStatus } from '@openbooks/shared-types';

import { ErrorBanner, Pill, ResponsiveTable } from '../components';
import type { PillTone } from '../components';
import { useTen99Runs } from './queries';

/**
 * The Runs tab of the 1099 Center: every filing run this org has generated, newest first
 * (OB-228 Wave-1 Stream D). A row opens the run detail route, the same list→detail split
 * `screens/sales.tsx`'s header comment argues for — a run is a link someone can send and a
 * URL that survives a refresh, not a piece of local state.
 */

const STATUS_TONE: Readonly<Record<Ten99RunStatus, PillTone>> = {
  draft: 'neutral',
  generated: 'accent',
  submitted: 'accent',
  accepted: 'positive',
  rejected: 'negative',
};

const STATUS_LABEL: Readonly<Record<Ten99RunStatus, string>> = {
  draft: 'Draft',
  generated: 'Generated',
  submitted: 'Submitted',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

export function Ten99RunsList(): ReactElement {
  const navigate = useNavigate();
  const runs = useTen99Runs();

  if (runs.error != null) {
    return <ErrorBanner error={runs.error} onRetry={() => void runs.refetch()} />;
  }

  if (runs.isPending) {
    return <p className="text-text-subtle">Loading runs…</p>;
  }

  if (runs.data.runs.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-surface p-6 text-center text-text-muted">
        No 1099 filing run has been generated yet.
      </p>
    );
  }

  return (
    <ResponsiveTable aria-label="1099 filing runs">
      <table className="w-full border-collapse text-base">
        <caption className="sr-only">1099 filing runs, newest first</caption>
        <thead>
          <tr className="border-b border-border text-left text-sm text-text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              Tax year
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Forms
            </th>
            <th scope="col" className="py-2 font-medium">
              E-file
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.data.runs.map((run) => (
            <RunRow key={run.id} run={run} onOpen={() => void navigate(`/ten99/runs/${run.id}`)} />
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}

function RunRow({
  run,
  onOpen,
}: {
  readonly run: Ten99Run;
  readonly onOpen: () => void;
}): ReactElement {
  return (
    <tr className="border-b border-border align-top last:border-0 hover:bg-surface-hover">
      <td className="py-2 pr-3 text-sm text-text">
        <button
          type="button"
          onClick={onOpen}
          className="rounded-sm font-mono text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
        >
          {run.taxYear}
        </button>
      </td>
      <td className="py-2 pr-3">
        <Pill tone={STATUS_TONE[run.status]}>{STATUS_LABEL[run.status]}</Pill>
      </td>
      <td className="py-2 pr-3 text-sm text-text">
        {run.forms.length} {run.forms.length === 1 ? 'form' : 'forms'}
      </td>
      <td className="py-2 text-sm text-text-muted">
        {run.efileProvider === null
          ? 'Not filed'
          : `${run.efileProvider} — ${run.efileRef ?? 'pending'}`}
      </td>
    </tr>
  );
}
