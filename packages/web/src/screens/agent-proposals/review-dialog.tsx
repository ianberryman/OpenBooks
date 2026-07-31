import type { ReactElement } from 'react';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  ErrorBanner,
  ResponsiveTable,
} from '../../components';
import { formatMinorUnits } from '../../money/format';
import type { Account, JournalDraftLine, JournalDraftSummary } from './queries';
import { useApproveProposal, useIntentKey, useProposalDetail, useRejectProposal } from './queries';

/**
 * Reviewing one proposal — the screen `agents.review` exists for (D-60).
 *
 * ## Approve is a direct button; there is no confirming dialog on top of this one
 *
 * Opening this dialog and reading the lines already *is* the deliberate step — the same
 * shape `journal-entry/draft-editor.tsx`'s own "Post entry" takes, a plain button with no
 * modal in front of it, despite also reaching the ledger permanently. A second
 * confirmation here would ask the reviewer to confirm a decision they have already made by
 * opening this dialog in the first place.
 *
 * ## Reject discards outright and is worded that way
 *
 * `rejectProposal`'s own description: "the same operation a person discarding their own
 * unfinished draft performs" (D-16) — nothing about a rejected proposal is recorded
 * anywhere, so the description here says so rather than implying the proposal is kept
 * somewhere for later.
 */
export interface ReviewProposalDialogProps {
  readonly proposal: JournalDraftSummary | null;
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly onOpenChange: (open: boolean) => void;
}

export function ReviewProposalDialog({
  proposal,
  accountsById,
  onOpenChange,
}: ReviewProposalDialogProps): ReactElement {
  return (
    <Dialog open={proposal !== null} onOpenChange={onOpenChange}>
      {proposal !== null && (
        <ReviewProposalContent
          key={proposal.id}
          proposal={proposal}
          accountsById={accountsById}
          onDone={() => {
            onOpenChange(false);
          }}
        />
      )}
    </Dialog>
  );
}

function accountLabel(
  accountId: string | null,
  accountsById: ReadonlyMap<string, Account>,
): string {
  if (accountId === null) return '—';
  const account = accountsById.get(accountId);
  return account === undefined ? accountId : `${account.code} · ${account.name}`;
}

function ReviewProposalContent({
  proposal,
  accountsById,
  onDone,
}: {
  readonly proposal: JournalDraftSummary;
  readonly accountsById: ReadonlyMap<string, Account>;
  readonly onDone: () => void;
}): ReactElement {
  const detail = useProposalDetail(proposal.id);
  const approve = useApproveProposal();
  const reject = useRejectProposal();
  const intentKey = useIntentKey();

  const pending = approve.isPending || reject.isPending;

  return (
    <DialogContent
      title="Review proposal"
      description={proposal.memo ?? 'No memo.'}
      className="max-w-2xl"
      footer={
        <>
          <DialogClose asChild>
            <Button disabled={pending}>Close</Button>
          </DialogClose>
          <Button
            variant="danger"
            disabled={pending || detail.draft === null}
            onClick={() => {
              reject.mutate(
                { draftId: proposal.id, idempotencyKey: intentKey(`reject:${proposal.id}`) },
                { onSuccess: onDone },
              );
            }}
          >
            {reject.isPending ? 'Rejecting…' : 'Reject'}
          </Button>
          <Button
            variant="primary"
            disabled={pending || detail.draft === null}
            onClick={() => {
              approve.mutate(
                { draftId: proposal.id, idempotencyKey: intentKey(`approve:${proposal.id}`) },
                { onSuccess: onDone },
              );
            }}
          >
            {approve.isPending ? 'Approving…' : 'Approve and post'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {detail.error != null && <ErrorBanner error={detail.error} />}
        {approve.isError && <ErrorBanner error={approve.error} />}
        {reject.isError && <ErrorBanner error={reject.error} />}

        {detail.isPending && <p className="text-text-subtle">Loading lines…</p>}

        {detail.draft !== null && (
          <ResponsiveTable>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">Proposed lines</caption>
              <thead>
                <tr className="text-left text-xs text-text-subtle">
                  <th scope="col" className="p-1 font-medium">
                    Account
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Debit
                  </th>
                  <th scope="col" className="p-1 text-right font-medium">
                    Credit
                  </th>
                  <th scope="col" className="p-1 font-medium">
                    Memo
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.draft.lines.map((line) => (
                  <LineRow key={line.lineId} line={line} accountsById={accountsById} />
                ))}
              </tbody>
            </table>
          </ResponsiveTable>
        )}
      </div>
    </DialogContent>
  );
}

function LineRow({
  line,
  accountsById,
}: {
  readonly line: JournalDraftLine;
  readonly accountsById: ReadonlyMap<string, Account>;
}): ReactElement {
  return (
    <tr className="border-t border-border">
      <td className="p-1 text-text">{accountLabel(line.accountId, accountsById)}</td>
      <td className="p-1 text-right font-mono tabular-nums text-text">
        {line.side === 'debit' ? formatMinorUnits(line.amount) : ''}
      </td>
      <td className="p-1 text-right font-mono tabular-nums text-text">
        {line.side === 'credit' ? formatMinorUnits(line.amount) : ''}
      </td>
      <td className="p-1 text-text-muted">{line.memo ?? '—'}</td>
    </tr>
  );
}
