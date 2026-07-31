import type { ReactElement } from 'react';

import { Button, formatMoney } from '../../components';
import { cx } from '../../lib/cx';
import type { BankMatchProposal, BankStatementLine } from './queries';
import { ReasonChips, proposalTarget, proposalVerb } from './reasons';

/**
 * One uncleared statement line, with its ranked proposals (OB-086).
 *
 * The row shows the bank's own facts — the date it posted, the narrative verbatim, the payee
 * where the format separated it, and the signed amount — and beneath them the candidates the
 * server ranked, best first. Each candidate carries its own Accept, so choosing a lower-ranked
 * one is a click and needs no dialog; the top one is also what Enter accepts when the row is
 * focused.
 *
 * ## The sign is the bank's, shown as the bank meant it
 *
 * `amount` is signed — positive into the account, negative out of it — because E4 is an
 * equation over amounts and a term whose sign must be looked up is where a sign error goes.
 * So the figure is coloured by its own sign (`amount-positive`/`amount-negative`, the money
 * roles, never `danger` — money leaving a current account is not an error) and the sign is
 * kept in the number rather than turned into a "debit/credit" label the bank never used.
 */

function isNegative(signedMinor: string): boolean {
  return signedMinor.startsWith('-') && signedMinor !== '-0';
}

/** The wire form carries a leading `-` on outflows; `formatMoney` renders it, so the
 *  displayed string already carries the sign. */
function signedAmount(signedMinor: string): string {
  return formatMoney(signedMinor);
}

export interface LineRowProps {
  readonly line: BankStatementLine;
  readonly proposals: readonly BankMatchProposal[] | undefined;
  readonly proposalsLoading: boolean;
  readonly focused: boolean;
  readonly accountName: (accountId: string) => string;
  readonly rowRef?: (node: HTMLLIElement | null) => void;
  readonly onFocus: () => void;
  readonly onAccept: (proposal: BankMatchProposal) => void;
  readonly onCorrect: () => void;
  readonly onSplit: () => void;
  readonly onDefer: () => void;
}

export function LineRow({
  line,
  proposals,
  proposalsLoading,
  focused,
  accountName,
  rowRef,
  onFocus,
  onAccept,
  onCorrect,
  onSplit,
  onDefer,
}: LineRowProps): ReactElement {
  const negative = isNegative(line.amount);

  return (
    <li
      ref={rowRef}
      // A group rather than a listbox option: the row owns several controls (an Accept per
      // proposal, Correct, Defer), and the roving focus is the screen's, tracked in state and
      // reflected here — not the browser's tab order, which would make Enter ambiguous.
      role="group"
      aria-label={`Statement line ${line.postedDate}, ${line.description}`}
      aria-current={focused ? 'true' : undefined}
      onMouseDown={onFocus}
      className={cx(
        'flex flex-col gap-2 rounded-lg border p-3',
        focused ? 'border-accent bg-surface-hover' : 'border-border bg-surface',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="font-mono text-xs text-text-subtle">{line.postedDate}</span>
          <span className="truncate text-sm text-text">{line.description}</span>
          {line.counterparty !== null && (
            <span className="truncate text-xs text-text-muted">{line.counterparty}</span>
          )}
        </div>
        <span
          className={cx(
            'shrink-0 font-mono text-base tabular-nums',
            negative ? 'text-amount-negative' : 'text-amount-positive',
          )}
        >
          {signedAmount(line.amount)}
        </span>
      </div>

      {proposalsLoading && proposals === undefined ? (
        <p className="text-xs text-text-subtle">Looking for matches…</p>
      ) : proposals !== undefined && proposals.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {proposals.map((proposal, index) => (
            <li
              key={proposal.id}
              className={cx(
                'flex items-center justify-between gap-3 rounded-md px-2 py-1.5',
                index === 0 && 'bg-surface-sunken',
              )}
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm text-text">
                  <span className="text-text-muted">{proposalVerb(proposal.kind)}</span>{' '}
                  {proposalTarget(proposal, accountName)}
                </span>
                <ReasonChips reasons={proposal.reasons} />
              </div>
              <Button
                size="sm"
                variant={index === 0 ? 'primary' : 'secondary'}
                onClick={() => {
                  onAccept(proposal);
                }}
                aria-label={`Accept: ${proposalVerb(proposal.kind)} ${proposalTarget(proposal, accountName)}`}
              >
                Accept
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-text-subtle">
          Nothing in the books resembles this line. Code it to an account, or leave it for now.
        </p>
      )}

      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onCorrect}>
          Correct
        </Button>
        <Button size="sm" variant="secondary" onClick={onSplit}>
          Multiple entries
        </Button>
        <Button size="sm" variant="ghost" onClick={onDefer}>
          Defer
        </Button>
      </div>
    </li>
  );
}
