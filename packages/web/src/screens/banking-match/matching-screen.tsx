import type { KeyboardEvent, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { newIdempotencyKey } from '../../api';
import {
  Button,
  Combobox,
  Dialog,
  DialogContent,
  ErrorBanner,
  formatMinorUnits,
} from '../../components';
import { cx } from '../../lib/cx';
import { CorrectDialog } from './correct-dialog';
import { LineRow } from './line-row';
import { MultiEntryDialog } from './multi-entry-dialog';
import { NewTransactionDialog } from './new-transaction-dialog';
import {
  postEntryToAccount,
  proposalToClearRequest,
  useAccountOptions,
  useBankAccountOptions,
  useClearLine,
  useLineProposals,
  useStatementLines,
  useUndoClearing,
} from './queries';
import type { BankMatchProposal, BankStatementLine, ClearRequest } from './queries';
import { MatchRefusal } from './refusal';
import { UndoDialog } from './undo-dialog';

/**
 * The matching screen (OB-086; ROADMAP M4, E3, E10, D-43, D-48).
 *
 * A business picks a bank account and works down its uncleared statement lines. Each line
 * shows the bank's own facts and the ranked proposals the server returned, best first, each
 * with the reasons behind it. For each line the user can **accept** the top proposal (or a
 * chosen one), **correct** it to an account nothing proposed, open **multiple entries**
 * (settle several documents, split across accounts, or add an early-pay discount — OB-140,
 * `multi-entry-dialog.tsx`), **defer** it (leave it uncleared for now), or — once cleared —
 * **undo**.
 *
 * ## Matching proposes; a human posts (E3)
 *
 * Nothing here writes to the ledger on its own. A proposal is computed, not stored (D-43),
 * and carries `rank` — the ordering — with deliberately no confidence score (D-48), because
 * a score is the field an auto-accept threshold is eventually built on. So the screen never
 * renders a percentage or a bar; it renders the order and the reasons, and every clear is a
 * keystroke a person made.
 *
 * ## Keyboard-driven, or worse than a spreadsheet
 *
 * The list holds the focus. Up/Down (or k/j) move between lines, Enter accepts the focused
 * line's top proposal, `c` opens the correct picker, `d` defers. The focused line is kept in
 * view. This is the point of the ticket: a person clearing a few hundred lines does it from
 * the keyboard or not at all.
 *
 * ## One batch per visible page (E10)
 *
 * Proposals are fetched for the lines the screen is *showing*, in a single request over
 * their `lineIds` — never one request per line. The window below (`PAGE`) bounds that batch
 * regardless of statement size, which is what keeps a 5,000-line statement from misbehaving.
 */

const PAGE = 25;

interface ActionError {
  readonly lineId: string;
  readonly error: unknown;
}

export function MatchingScreen(): ReactElement {
  const bankAccounts = useBankAccountOptions();
  const [bankAccountId, setBankAccountId] = useState<string | null>(null);
  const [view, setView] = useState<'to-match' | 'matched'>('to-match');
  const [newTransactionOpen, setNewTransactionOpen] = useState(false);

  const accountOptions = useMemo(
    () =>
      bankAccounts.map((account) => ({
        value: account.id,
        label: account.name,
        // Omitted rather than `undefined`: `exactOptionalPropertyTypes` makes an absent
        // optional prop and an explicitly-undefined one different types.
        ...(account.institutionName === null ? {} : { detail: account.institutionName }),
      })),
    [bankAccounts],
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-text">Match transactions</h1>

      <div className="flex max-w-md flex-col gap-1">
        <span className="text-sm font-medium text-text">Bank account</span>
        <Combobox
          aria-label="Bank account"
          value={bankAccountId}
          onValueChange={setBankAccountId}
          options={accountOptions}
          placeholder="Pick a bank account…"
          emptyMessage="No bank accounts. Add one before matching."
        />
      </div>

      {bankAccountId === null ? (
        <p className="text-text-muted">Pick a bank account to start matching its statement.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2" role="tablist" aria-label="Which lines to show">
              <ViewTab active={view === 'to-match'} onClick={() => setView('to-match')}>
                To match
              </ViewTab>
              <ViewTab active={view === 'matched'} onClick={() => setView('matched')}>
                Matched
              </ViewTab>
            </div>
            {/* A line the bank shows before its file arrives — a same-day deposit, a fee — can
                be entered by hand here; it joins "To match" and dedupes against a later import. */}
            <Button onClick={() => setNewTransactionOpen(true)}>New transaction</Button>
          </div>

          {view === 'to-match' ? (
            <ToMatchView key={`to-match-${bankAccountId}`} bankAccountId={bankAccountId} />
          ) : (
            <MatchedView key={`matched-${bankAccountId}`} bankAccountId={bankAccountId} />
          )}

          <NewTransactionDialog
            bankAccountId={bankAccountId}
            open={newTransactionOpen}
            onOpenChange={setNewTransactionOpen}
          />
        </>
      )}
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        'rounded-md border px-3 py-1 text-sm',
        active
          ? 'border-accent bg-accent-soft text-text'
          : 'border-border bg-surface text-text-muted hover:bg-surface-hover',
      )}
    >
      {children}
    </button>
  );
}

function ToMatchView({ bankAccountId }: { readonly bankAccountId: string }): ReactElement {
  const accounts = useAccountOptions();
  const accountName = useMemo(() => {
    const byId = new Map(accounts.map((account) => [account.id, account.name] as const));
    return (accountId: string): string => byId.get(accountId) ?? 'account';
  }, [accounts]);

  const linesQuery = useStatementLines(bankAccountId, false);
  const clear = useClearLine();

  const [deferred, setDeferred] = useState<ReadonlySet<string>>(() => new Set());
  const [windowStart, setWindowStart] = useState(0);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [correctFor, setCorrectFor] = useState<BankStatementLine | null>(null);
  const [correctError, setCorrectError] = useState<unknown>(null);
  const [splitFor, setSplitFor] = useState<BankStatementLine | null>(null);
  const [splitError, setSplitError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<ActionError | null>(null);

  const allLines = useMemo(
    () => linesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [linesQuery.data],
  );
  const lines = useMemo(
    () => allLines.filter((line) => !deferred.has(line.id)),
    [allLines, deferred],
  );
  const visible = useMemo(() => lines.slice(windowStart, windowStart + PAGE), [lines, windowStart]);

  // A new array each render, but the query key hashes structurally, so identical ids are one
  // cache entry and no refetch loop — the batch fires once per distinct window (E10).
  const visibleIds = useMemo(() => visible.map((line) => line.id), [visible]);
  const proposalsQuery = useLineProposals(visibleIds);
  const proposalsByLine = proposalsQuery.data;

  const clampedFocus = visible.length === 0 ? 0 : Math.min(focusedIndex, visible.length - 1);

  const listRef = useRef<HTMLUListElement>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  // Keep the focused row in view without stealing focus from the list — the roving focus is
  // in state, so the browser's scroll anchoring never sees it move.
  useEffect(() => {
    const focusedLine = visible[clampedFocus];
    if (focusedLine === undefined) return;
    rowRefs.current.get(focusedLine.id)?.scrollIntoView({ block: 'nearest' });
  }, [clampedFocus, visible]);

  const defer = useCallback((lineId: string): void => {
    setDeferred((prev) => {
      const next = new Set(prev);
      next.add(lineId);
      return next;
    });
  }, []);

  const accept = useCallback(
    (line: BankStatementLine, proposal: BankMatchProposal): void => {
      setActionError(null);
      // The key is minted here — at the keystroke that is the user's intent — so a React
      // Query retry of the same accept carries the same key and does not post twice.
      clear.mutate(
        {
          lineId: line.id,
          body: proposalToClearRequest(proposal),
          idempotencyKey: newIdempotencyKey(),
        },
        { onError: (error) => setActionError({ lineId: line.id, error }) },
      );
    },
    [clear],
  );

  const submitCorrection = useCallback(
    (accountId: string): void => {
      if (correctFor === null) return;
      const line = correctFor;
      setCorrectError(null);
      clear.mutate(
        {
          lineId: line.id,
          body: postEntryToAccount(accountId),
          idempotencyKey: newIdempotencyKey(),
        },
        {
          onSuccess: () => setCorrectFor(null),
          onError: (error) => setCorrectError(error),
        },
      );
    },
    [clear, correctFor],
  );

  const submitSplit = useCallback(
    (body: ClearRequest): void => {
      if (splitFor === null) return;
      const line = splitFor;
      setSplitError(null);
      clear.mutate(
        { lineId: line.id, body, idempotencyKey: newIdempotencyKey() },
        {
          onSuccess: () => setSplitFor(null),
          onError: (error) => setSplitError(error),
        },
      );
    },
    [clear, splitFor],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>): void => {
      if (visible.length === 0) return;
      const line = visible[clampedFocus];

      switch (event.key) {
        case 'ArrowDown':
        case 'j':
          event.preventDefault();
          setFocusedIndex(Math.min(clampedFocus + 1, visible.length - 1));
          return;
        case 'ArrowUp':
        case 'k':
          event.preventDefault();
          setFocusedIndex(Math.max(clampedFocus - 1, 0));
          return;
        case 'Enter': {
          if (line === undefined) return;
          const top = proposalsByLine?.get(line.id)?.[0];
          if (top === undefined) return;
          event.preventDefault();
          accept(line, top);
          return;
        }
        case 'c':
        case 'C':
          if (line === undefined) return;
          event.preventDefault();
          setCorrectError(null);
          setCorrectFor(line);
          return;
        case 'd':
        case 'D':
          if (line === undefined) return;
          event.preventDefault();
          defer(line.id);
          return;
        default:
          return;
      }
    },
    [visible, clampedFocus, proposalsByLine, accept, defer],
  );

  if (linesQuery.isError) {
    return (
      <ErrorBanner
        error={linesQuery.error}
        onRetry={() => {
          void linesQuery.refetch();
        }}
      />
    );
  }

  if (linesQuery.isPending) {
    return <p className="text-text-muted">Loading statement lines…</p>;
  }

  if (lines.length === 0) {
    return (
      <p className="text-text-muted">
        {deferred.size > 0
          ? 'Nothing left to match — the rest was deferred. Reload to bring the deferred lines back.'
          : 'No uncleared lines. This statement is fully matched.'}
      </p>
    );
  }

  const windowEnd = Math.min(windowStart + PAGE, lines.length);

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-x-3 gap-y-1',
          'text-sm text-text-muted',
        )}
      >
        <span>
          Lines {windowStart + 1}–{windowEnd} of {lines.length} loaded
          {deferred.size > 0 ? ` · ${String(deferred.size)} deferred` : ''}
        </span>
        <span className="text-xs text-text-subtle">
          ↑↓ move · Enter accept top · c correct · d defer
        </span>
      </div>

      {actionError !== null && <MatchRefusal error={actionError.error} />}

      <ul
        ref={listRef}
        tabIndex={0}
        aria-label="Uncleared statement lines"
        onKeyDown={onKeyDown}
        className="flex flex-col gap-2 rounded-md outline-none"
      >
        {visible.map((line, index) => (
          <LineRow
            key={line.id}
            line={line}
            proposals={proposalsByLine?.get(line.id)}
            proposalsLoading={proposalsQuery.isPending}
            focused={index === clampedFocus}
            accountName={accountName}
            rowRef={(node) => {
              if (node === null) rowRefs.current.delete(line.id);
              else rowRefs.current.set(line.id, node);
            }}
            onFocus={() => setFocusedIndex(index)}
            onAccept={(proposal) => accept(line, proposal)}
            onCorrect={() => {
              setCorrectError(null);
              setCorrectFor(line);
            }}
            onSplit={() => {
              setSplitError(null);
              setSplitFor(line);
            }}
            onDefer={() => defer(line.id)}
          />
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={windowStart === 0}
          onClick={() => {
            setWindowStart(Math.max(0, windowStart - PAGE));
            setFocusedIndex(0);
          }}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={windowEnd >= lines.length}
          onClick={() => {
            setWindowStart(windowStart + PAGE);
            setFocusedIndex(0);
          }}
        >
          Next
        </Button>
        {linesQuery.hasNextPage && (
          <Button
            size="sm"
            variant="ghost"
            disabled={linesQuery.isFetchingNextPage}
            onClick={() => {
              void linesQuery.fetchNextPage();
            }}
          >
            Load more lines
          </Button>
        )}
      </div>

      <Dialog
        open={correctFor !== null}
        onOpenChange={(next) => {
          if (!next) setCorrectFor(null);
        }}
      >
        {correctFor !== null && (
          <DialogContent title="Correct this line" description="Code it to an account you choose.">
            <CorrectDialog
              line={correctFor}
              accounts={accounts}
              pending={clear.isPending}
              error={correctError}
              onSubmit={submitCorrection}
              onClose={() => setCorrectFor(null)}
            />
          </DialogContent>
        )}
      </Dialog>

      <Dialog
        open={splitFor !== null}
        onOpenChange={(next) => {
          if (!next) setSplitFor(null);
        }}
      >
        {splitFor !== null && (
          <DialogContent
            title="Multiple entries"
            description="Settle several documents, split across accounts, or add an early-pay discount — the entries must add up to the line."
          >
            <MultiEntryDialog
              line={splitFor}
              accounts={accounts}
              pending={clear.isPending}
              error={splitError}
              onSubmit={submitSplit}
              onClose={() => setSplitFor(null)}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function MatchedView({ bankAccountId }: { readonly bankAccountId: string }): ReactElement {
  const linesQuery = useStatementLines(bankAccountId, true);
  const undo = useUndoClearing();

  const [undoFor, setUndoFor] = useState<BankStatementLine | null>(null);
  const [undoError, setUndoError] = useState<unknown>(null);

  const lines = useMemo(
    () => linesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [linesQuery.data],
  );

  const submitUndo = useCallback(
    (date: string, memo: string | null): void => {
      if (undoFor === null) return;
      const line = undoFor;
      setUndoError(null);
      undo.mutate(
        { lineId: line.id, date, memo, idempotencyKey: newIdempotencyKey() },
        {
          onSuccess: () => setUndoFor(null),
          onError: (error) => setUndoError(error),
        },
      );
    },
    [undo, undoFor],
  );

  if (linesQuery.isError) {
    return (
      <ErrorBanner
        error={linesQuery.error}
        onRetry={() => {
          void linesQuery.refetch();
        }}
      />
    );
  }

  if (linesQuery.isPending) {
    return <p className="text-text-muted">Loading matched lines…</p>;
  }

  if (lines.length === 0) {
    return <p className="text-text-muted">No cleared lines yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" aria-label="Cleared statement lines">
        {lines.map((line) => (
          <li
            key={line.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3"
          >
            <div className="flex min-w-0 flex-col">
              <span className="font-mono text-xs text-text-subtle">{line.postedDate}</span>
              <span className="truncate text-sm text-text">{line.description}</span>
              {line.clearing !== null && (
                <span className="text-xs text-text-muted">
                  {clearingSummary(line.clearing.entries)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-base tabular-nums text-text">
                {formatMinorUnits(line.amount)}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setUndoError(null);
                  setUndoFor(line);
                }}
                aria-label={`Undo clearing of ${line.postedDate} ${line.description}`}
              >
                Undo
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Dialog
        open={undoFor !== null}
        onOpenChange={(next) => {
          if (!next) setUndoFor(null);
        }}
      >
        {undoFor !== null && (
          <DialogContent
            title="Undo this clearing"
            description="Its journal is reversed, not deleted."
          >
            <UndoDialog
              line={undoFor}
              pending={undo.isPending}
              error={undoError}
              onSubmit={submitUndo}
              onClose={() => setUndoFor(null)}
            />
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

const CLEARING_METHOD_LABEL: Readonly<Record<string, string>> = {
  post_entry: 'Coded to an account',
  link_entry: 'Linked to an existing entry',
  allocate_document: 'Settled a document',
  discount: 'Early-pay discount',
};

/**
 * A clearing is now one or more entries (D-80); this row summarises rather than
 * enumerating them. A single entry keeps its old one-word summary; more than one just says
 * how many, which is enough for the matched list — the entries themselves were built, and
 * can be reviewed, in `MultiEntryDialog` (OB-140) before the clear was accepted, not after it
 * on this read-only row.
 */
function clearingSummary(entries: readonly { readonly entryType: string }[]): string {
  const [only] = entries;
  if (entries.length === 1 && only !== undefined) {
    return CLEARING_METHOD_LABEL[only.entryType] ?? 'Cleared';
  }
  return `Cleared — ${String(entries.length)} entries`;
}
