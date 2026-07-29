import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { Button, ErrorBanner } from '../components';
import { ProposalList } from './agent-proposals/list';
import { useAccounts, useProposalList } from './agent-proposals/queries';
import type { JournalDraftSummary } from './agent-proposals/queries';
import { ReviewProposalDialog } from './agent-proposals/review-dialog';

/**
 * The agent review queue (OB-105; OB-060, OB-103 — ROADMAP D-19, D-60).
 *
 * What finally activates `agents.review`, seeded and latent since M1: an agent's write
 * never posts directly (D-43 generalized to every agent write), it lands here as a
 * `journal_drafts` row a human turns into a posting or discards, and this is the one
 * place that happens. See `agent-proposals/queries.ts` for how a proposal and an ordinary
 * journal draft are, underneath, the same row.
 */
export function AgentProposalsScreen(): ReactElement {
  const [reviewing, setReviewing] = useState<JournalDraftSummary | null>(null);

  const accounts = useAccounts();
  const list = useProposalList();

  const proposals = useMemo(
    () => list.data?.pages.flatMap((page) => page.items) ?? [],
    [list.data],
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-text">Agent proposals</h1>
        <p className="max-w-form text-text-muted">
          Journal entries an agent has proposed and not yet posted. An agent never posts to the
          ledger itself — approving here is what does, and rejecting discards the proposal outright
          with nothing recorded.
        </p>
      </div>

      {accounts.error != null && <ErrorBanner error={accounts.error} />}
      {list.error != null && (
        <ErrorBanner
          error={list.error}
          onRetry={() => {
            void list.refetch();
          }}
        />
      )}

      <ProposalList
        proposals={proposals}
        loading={list.isPending}
        onReview={(proposal) => {
          setReviewing(proposal);
        }}
      />

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

      <ReviewProposalDialog
        proposal={reviewing}
        accountsById={accounts.accountsById}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
      />
    </div>
  );
}
