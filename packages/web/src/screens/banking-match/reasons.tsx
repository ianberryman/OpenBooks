import type { ReactElement } from 'react';

import { formatMinorUnits } from '../../components';
import { cx } from '../../lib/cx';
import type { BankMatchProposal, BankMatchReason, ProposalKind } from './queries';

/**
 * The wording for a reason, and for what accepting a proposal would do (ROADMAP D-43).
 *
 * ## The client owns the words, the server owns the fact
 *
 * A reason arrives as a stable token — `amount_exact`, `date_close` — plus the numbers
 * behind it (`amountDifference`, `dayDifference`), and never as a sentence. D-43 puts the
 * phrasing here on purpose: the server states *why* it proposed the candidate, and this file
 * decides how that reads to a person, so the copy can change without a server release and a
 * renamed token is a compile error rather than a silently wrong chip.
 *
 * ## There is no score, and none is manufactured
 *
 * `rank` is the ordering and there is deliberately no confidence number (D-48) — a score is
 * the field an auto-accept threshold is eventually built on, and this milestone proposes;
 * a human posts (E3). So a proposal shows its rank position and its reasons, never a
 * percentage and never a bar.
 */

/** Magnitude of a signed minor-units string, formatted — arithmetic in `bigint`, never
 *  `Number()` (D-13). A difference of `"-4500"` reads as `45.00`, the sign carried by the
 *  word ("earlier"/"short"), not repeated in the figure. */
function magnitude(signedMinor: string): string {
  const value = BigInt(signedMinor);
  return formatMinorUnits((value < 0n ? -value : value).toString());
}

function days(count: number): string {
  const n = Math.abs(count);
  return `${String(n)} day${n === 1 ? '' : 's'}`;
}

export function reasonLabel(reason: BankMatchReason): string {
  switch (reason.code) {
    case 'amount_exact':
      return 'exact amount';
    case 'amount_close':
      return reason.amountDifference === null
        ? 'amount close'
        : `amount off by ${magnitude(reason.amountDifference)}`;
    case 'date_exact':
      return 'same day';
    case 'date_close':
      if (reason.dayDifference === null) return 'date close';
      // Negative is the candidate being earlier than the statement line (schema).
      return reason.dayDifference < 0
        ? `${days(reason.dayDifference)} earlier`
        : `${days(reason.dayDifference)} later`;
    case 'reference_match':
      return 'reference matches';
    case 'counterparty_match':
      return 'same counterparty';
    case 'description_match':
      return 'description matches';
    case 'rule_match':
      return 'matched a rule';
    case 'contact_history':
      return 'seen before for this contact';
  }
}

/**
 * What accepting this proposal *does*, in a word — the near label on the row.
 *
 * The three `kind`s are the three clearing methods (D-43): code the line to an account,
 * link it to an entry already posted, or settle a document with it.
 */
const KIND_VERB: Readonly<Record<ProposalKind, string>> = {
  post_entry: 'Code to',
  link_entry: 'Link to entry',
  allocate_document: 'Settle',
};

export function proposalVerb(kind: ProposalKind): string {
  return KIND_VERB[kind];
}

/**
 * The target of a proposal, resolved without a fetch.
 *
 * `allocate_document` carries its own `contactName` and `documentNumber` — carried rather
 * than resolved by the client for the reason the aging report carries them: a page of a few
 * hundred proposals would otherwise fetch a few hundred contacts. `link_entry` names its
 * journal by memo or date. `post_entry` names the account by id, and the row resolves that
 * against the loaded chart — the one lookup that is cheap because the chart is one list.
 */
export function proposalTarget(
  proposal: BankMatchProposal,
  accountName: (accountId: string) => string,
): string {
  switch (proposal.kind) {
    case 'post_entry':
      return accountName(proposal.accountId);
    case 'link_entry':
      return proposal.journalMemo ?? `Journal dated ${proposal.journalDate}`;
    case 'allocate_document': {
      const number = proposal.documentNumber ?? proposal.targetType;
      return `${number} · ${proposal.contactName}`;
    }
  }
}

export function ReasonChips({
  reasons,
}: {
  readonly reasons: readonly BankMatchReason[];
}): ReactElement {
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Why this was proposed">
      {reasons.map((reason, index) => (
        <li
          key={`${reason.code}-${String(index)}`}
          className={cx(
            'inline-flex items-center rounded-full border border-border bg-surface-sunken',
            'px-2 py-0.5 text-xs text-text-muted',
          )}
        >
          {reasonLabel(reason)}
        </li>
      ))}
    </ul>
  );
}
