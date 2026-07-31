import type { ReactElement } from 'react';

import { Button, ResponsiveTable } from '../../components';
import { cx } from '../../lib/cx';
import { EmptyRow, TABLE_CLASSES, TD_CLASSES, TH_CLASSES } from '../settings/section';
import type { JournalDraftSummary } from './queries';

/**
 * One page of pending proposals — headers only, no lines (see `queries.ts` for why). A
 * row's "Review" button is the only way to see what a proposal would post at all.
 */
export interface ProposalListProps {
  readonly proposals: readonly JournalDraftSummary[];
  readonly loading: boolean;
  readonly onReview: (proposal: JournalDraftSummary) => void;
}

export function ProposalList({ proposals, loading, onReview }: ProposalListProps): ReactElement {
  return (
    <ResponsiveTable>
      <table className={TABLE_CLASSES}>
        <caption className="sr-only">Agent proposals</caption>
        <thead>
          <tr>
            <th scope="col" className={TH_CLASSES}>
              Entry date
            </th>
            <th scope="col" className={TH_CLASSES}>
              Reference
            </th>
            <th scope="col" className={TH_CLASSES}>
              Memo
            </th>
            <th scope="col" className={TH_CLASSES}>
              Proposed
            </th>
            <th scope="col" className={cx(TH_CLASSES, 'text-right')}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {proposals.length === 0 && (
            <EmptyRow columns={5}>{loading ? 'Loading…' : 'Nothing waiting on review.'}</EmptyRow>
          )}
          {proposals.map((proposal) => (
            <tr key={proposal.id}>
              <td className={cx(TD_CLASSES, 'font-mono')}>{proposal.entryDate ?? '—'}</td>
              <td className={TD_CLASSES}>{proposal.reference ?? '—'}</td>
              <td className={TD_CLASSES}>{proposal.memo ?? '—'}</td>
              <td className={cx(TD_CLASSES, 'text-text-muted')}>{proposal.createdAt}</td>
              <td className={cx(TD_CLASSES, 'text-right')}>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    onReview(proposal);
                  }}
                >
                  Review
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ResponsiveTable>
  );
}
