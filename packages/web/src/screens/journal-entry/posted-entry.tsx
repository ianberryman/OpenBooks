import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useMemo, useState } from 'react';

import { api, idempotencyHeader, presentApiError, unwrap } from '../../api';
import {
  Button,
  Dialog,
  DialogContent,
  ErrorBanner,
  Field,
  FieldLabel,
  ResponsiveTable,
  TextInput,
  formatMoney,
} from '../../components';
import { totalsOf } from './balance';
import { todayIsoDate } from './draft-state';
import { idempotencyKeyFor, releaseIdempotencyKey } from './idempotency-keys';
import { journalEntryKeys } from './queries';
import type { PostedJournal, ReferenceData } from './queries';

/**
 * A posted entry: what the ledger stored, and the one thing that may still be done
 * about it.
 *
 * ## There is no edit affordance, and there could not be
 *
 * Journals are append-only at the database level. The application connects as
 * `openbooks_app`, which holds no `UPDATE` and no `DELETE` on `journals` or
 * `journal_lines` — that is acceptance A6, enforced by a grant that was never issued
 * rather than by care in this file. A pencil icon here would be a promise the schema
 * refuses to keep, and the user would find that out after retyping the entry.
 *
 * So the correction is a reversal (D-02, D-16): a *new* journal with every side
 * inverted and `reversesJournalId` set, after which both entries exist. That is why the
 * control below says Reverse and not Delete, and why it asks for a date — a reversal
 * has its own, and it must itself fall in an open period.
 */
export interface PostedEntryProps {
  readonly journal: PostedJournal;
  readonly reference: ReferenceData;
  /** A reversal is itself a posted journal, so reversing simply replaces what is shown. */
  readonly onReversed: (reversal: PostedJournal) => void;
  readonly onBackToDrafts: () => void;
}

const REVERSE_JOURNAL = 'reverseJournal';

function AccountCell({
  reference,
  accountId,
}: {
  readonly reference: ReferenceData;
  readonly accountId: string;
}): ReactElement {
  const account = reference.accountsById.get(accountId);
  return (
    <span className="flex flex-col">
      <span className="text-text">{account?.name ?? 'Unknown account'}</span>
      {account !== undefined && (
        <span className="font-mono text-xs text-text-subtle">{account.code}</span>
      )}
    </span>
  );
}

export function PostedEntry({
  journal,
  reference,
  onReversed,
  onBackToDrafts,
}: PostedEntryProps): ReactElement {
  const queryClient = useQueryClient();

  const [confirmingReversal, setConfirmingReversal] = useState(false);
  const [reversalDate, setReversalDate] = useState(() => todayIsoDate());
  const [reversalMemo, setReversalMemo] = useState('');
  const [failure, setFailure] = useState<unknown>(null);

  const totals = useMemo(() => totalsOf(journal.lines), [journal.lines]);

  const presented = failure === null ? null : presentApiError(failure);
  const fieldErrors = presented?.fieldErrors ?? {};

  const reverse = useMutation({
    mutationFn: async (variables: {
      readonly idempotencyKey: string;
      readonly date: string;
      readonly memo: string;
    }) =>
      unwrap(
        await api.POST('/v1/journals/{journalId}/reverse', {
          body: {
            date: variables.date,
            ...(variables.memo.trim() === '' ? {} : { memo: variables.memo.trim() }),
          },
          params: {
            path: { journalId: journal.journalId },
            header: idempotencyHeader(variables.idempotencyKey),
          },
        }),
      ),
  });

  async function handleReverse(): Promise<void> {
    setFailure(null);
    try {
      const reversal = await reverse.mutateAsync({
        // One key per journal, for the reason the Post button has one per draft: a
        // reversal is a posting, and a second click that minted a second key would
        // reverse the entry twice.
        idempotencyKey: idempotencyKeyFor(REVERSE_JOURNAL, journal.journalId),
        date: reversalDate,
        memo: reversalMemo,
      });
      releaseIdempotencyKey(REVERSE_JOURNAL, journal.journalId);
      void queryClient.invalidateQueries({ queryKey: journalEntryKeys.drafts });
      setConfirmingReversal(false);
      setReversalMemo('');
      onReversed(reversal);
    } catch (error) {
      setFailure(error);
    }
  }

  return (
    <section className="flex flex-col gap-4" aria-label="Posted journal entry">
      <div className="flex flex-wrap items-start gap-3 rounded-lg border border-success-border bg-success-soft p-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-sm font-semibold text-success-text">Posted to the ledger</p>
          <p className="text-sm text-text-muted">
            {journal.reversesJournalId === null
              ? 'This entry is part of the books and cannot be edited or deleted. A correction is a reversal.'
              : 'This entry reverses another. Both entries remain in the books.'}
          </p>
        </div>
      </div>

      {/*
        Only when the dialog is closed. A reversal can only fail from inside that
        dialog, and the dialog renders over this section — so a banner here during a
        failed reversal is drawn underneath the overlay, where the user cannot read
        it. OB-055 hit exactly that: a 500 presented as a dialog that stayed open with
        the fields intact and no visible reason. The banner moves inside
        `DialogContent` below; this one is left for a failure that arrives with no
        dialog open, which is the reversal-succeeded-then-refetch-failed case.
      */}
      {presented !== null && !confirmingReversal && <ErrorBanner error={failure} />}

      <dl className="flex flex-wrap gap-6">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-subtle">Entry date</dt>
          <dd className="text-text">{journal.date}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-subtle">Description</dt>
          <dd className="text-text">{journal.memo ?? '—'}</dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs text-text-subtle">Journal</dt>
          <dd className="font-mono text-xs text-text-muted">{journal.journalId}</dd>
        </div>
      </dl>

      <ResponsiveTable>
        <table className="w-full border-collapse text-base">
          <caption className="sr-only">Posted journal lines</caption>
          <thead>
            <tr className="text-left text-xs text-text-subtle">
              <th scope="col" className="border-b border-border p-2 font-medium">
                Account
              </th>
              <th scope="col" className="border-b border-border p-2 font-medium">
                Contact
              </th>
              <th scope="col" className="border-b border-border p-2 font-medium">
                Description
              </th>
              <th scope="col" className="border-b border-border p-2 font-medium">
                Tags
              </th>
              <th scope="col" className="border-b border-border p-2 text-right font-medium">
                Debit
              </th>
              <th scope="col" className="border-b border-border p-2 text-right font-medium">
                Credit
              </th>
            </tr>
          </thead>
          <tbody>
            {journal.lines.map((line) => (
              <tr key={line.lineId} className="align-top">
                <td className="border-b border-border p-2">
                  <AccountCell reference={reference} accountId={line.accountId} />
                </td>
                <td className="border-b border-border p-2 text-text-muted">
                  {line.contactId === null
                    ? '—'
                    : (reference.contactsById.get(line.contactId)?.displayName ?? '—')}
                </td>
                <td className="border-b border-border p-2 text-text-muted">{line.memo ?? '—'}</td>
                <td className="border-b border-border p-2 text-text-muted">
                  {line.dimensionValueIds.length === 0
                    ? '—'
                    : line.dimensionValueIds
                        .map((id) => reference.valuesById.get(id)?.name ?? id)
                        .join(', ')}
                </td>
                <td className="border-b border-border p-2 text-right font-mono tabular-nums">
                  {line.side === 'debit' ? formatMoney(line.amount) : ''}
                </td>
                <td className="border-b border-border p-2 text-right font-mono tabular-nums">
                  {line.side === 'credit' ? formatMoney(line.amount) : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-sm">
              <th scope="row" colSpan={4} className="p-2 text-right font-medium text-text-subtle">
                Totals
              </th>
              <td className="p-2 text-right font-mono tabular-nums text-text">
                {formatMoney(String(totals.debits))}
              </td>
              <td className="p-2 text-right font-mono tabular-nums text-text">
                {formatMoney(String(totals.credits))}
              </td>
            </tr>
          </tfoot>
        </table>
      </ResponsiveTable>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        <Button onClick={onBackToDrafts}>Back to drafts</Button>

        <div className="flex-1" />

        <Button
          variant="danger"
          disabled={reverse.isPending}
          onClick={() => setConfirmingReversal(true)}
        >
          Reverse entry
        </Button>
      </div>

      <Dialog open={confirmingReversal} onOpenChange={setConfirmingReversal}>
        <DialogContent
          title="Reverse this entry"
          description={
            'A new journal is posted with every line’s side inverted. The original is ' +
            'untouched, and after this both entries exist.'
          }
          footer={
            <>
              <Button onClick={() => setConfirmingReversal(false)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={reverse.isPending}
                onClick={() => {
                  void handleReverse();
                }}
              >
                {reverse.isPending ? 'Reversing…' : 'Post reversal'}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            {presented !== null && <ErrorBanner error={failure} />}
            <Field error={fieldErrors['date']}>
              <FieldLabel>Reversal date</FieldLabel>
              <TextInput
                type="date"
                value={reversalDate}
                onChange={(event) => setReversalDate(event.target.value)}
              />
            </Field>
            <Field error={fieldErrors['memo']}>
              <FieldLabel>Description</FieldLabel>
              <TextInput
                value={reversalMemo}
                placeholder="Why this entry is being reversed"
                onChange={(event) => setReversalMemo(event.target.value)}
              />
            </Field>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
