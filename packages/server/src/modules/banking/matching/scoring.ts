import type {
  BankMatchProposal,
  BankMatchReason,
  BankMatchReasonCode,
} from '@openbooks/shared-types';
import { BANK_MATCH_PROPOSALS_PER_LINE } from '@openbooks/shared-types';

import { dayDifference } from './dates';

/**
 * The ranking, which is the whole product (OB-079; ROADMAP D-43, acceptance E3).
 *
 * D-43 puts confidence "in the ordering of proposals, not in the decision to write",
 * and this file is where that ordering is decided. It builds a deterministic score
 * from the reasons a candidate carries, sorts by it, and then **throws the score
 * away** — the wire contract publishes `rank` and the `reasons`, never a number a
 * client could threshold. A score in the response is the field an auto-accept slider
 * is eventually built on (see `matching.ts`), so it does not leave this module.
 *
 * ## The order, and why it is this order
 *
 * A candidate's score is the sum of its reasons' weights. The weights encode the
 * judgements the ticket asks for, and each is a claim that can be argued:
 *
 *  - A **rule match** is the org saying, in advance, "a line like this is coded
 *    here" (D-44). It is high-confidence classification and ranks near the top.
 *  - An **exact amount** is strong; a **matching reference** is stronger still,
 *    because a bank reference is an identifier and not a coincidence. An exact amount
 *    *and* a matching reference on an entry the ledger already holds is the strongest
 *    signal there is — a link to an existing entry beats posting a duplicate — so a
 *    `link_entry` carrying both can out-rank even a rule.
 *  - An **exact amount** is worth more than a **close** one, and a matching
 *    **counterparty** or a coding this org has **used before** for the same
 *    counterparty is a real but weaker signal than the amount agreeing to the penny.
 *  - **Date** agreement is corroboration, not identification: two payments of the
 *    same amount on the same day are common, so date is the lightest weight and never
 *    stands alone (a candidate qualifies on amount or counterparty first).
 *
 * The weights are deliberately spread so the intended precedence is not an accident
 * of two of them summing to a third; the tests assert the precedence directly, so a
 * later re-weighting that breaks it fails rather than silently re-orders a screen.
 * D-43's point is that this can change "without a migration" — nothing downstream
 * reads anything but the resulting order.
 *
 * ## Ties break on the candidate's own identity, never on the response id
 *
 * The `id` on a proposal is minted fresh on every call (a proposal is computed, not
 * stored — D-43), so ordering on it would make the same statement return a different
 * order twice. The tie-break is therefore the candidate's *stable* identity: the
 * journal, document, or account-and-rule it points at, which is the same on every
 * call. Two distinct candidates for one line always differ there, so the order is
 * total and reproducible.
 */

const REASON_WEIGHTS: Record<BankMatchReasonCode, number> = {
  rule_match: 1000,
  amount_exact: 500,
  reference_match: 450,
  counterparty_match: 250,
  contact_history: 200,
  amount_close: 150,
  date_exact: 120,
  description_match: 100,
  date_close: 40,
};

/**
 * A proposal before it has been ranked. The wire shape minus `rank`, distributed over
 * the union so each kind keeps its own fields rather than collapsing to their
 * intersection.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ProposalDraft = DistributiveOmit<BankMatchProposal, 'rank'>;

function scoreOf(reasons: readonly BankMatchReason[]): number {
  let total = 0;
  for (const reason of reasons) total += REASON_WEIGHTS[reason.code];
  return total;
}

/**
 * The stable tie-break key: kind first (a fixed precedence, not a judgement — the
 * score has already ordered by strength), then the candidate's own durable id.
 */
function tieKey(draft: ProposalDraft): string {
  switch (draft.kind) {
    case 'link_entry':
      return `0:${draft.journalId}`;
    case 'allocate_document':
      return `1:${draft.targetType}:${draft.targetId}`;
    case 'post_entry':
      return `2:${draft.accountId}:${draft.ruleId ?? 'history'}`;
  }
}

/**
 * Orders one line's candidates best-first, caps them at ten, and stamps the rank.
 *
 * The score is computed here and discarded here: what leaves is `rank` (1-first) and
 * the reasons that justified it. Ten is `BANK_MATCH_PROPOSALS_PER_LINE` — past a
 * handful another plausible row makes a human decision slower rather than better.
 */
export function rankProposals(drafts: readonly ProposalDraft[]): BankMatchProposal[] {
  const scored = drafts.map((draft) => ({
    draft,
    score: scoreOf(draft.reasons),
    key: tieKey(draft),
  }));

  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

  return scored
    .slice(0, BANK_MATCH_PROPOSALS_PER_LINE)
    .map(({ draft }, index): BankMatchProposal => ({ ...draft, rank: index + 1 }));
}

// ---------------------------------------------------------------------------
// Match semantics — what "close", "matching reference", "same counterparty" mean.
// One place, so the service assembles data and this file judges likeness.
// ---------------------------------------------------------------------------

const MINIMUM_AMOUNT_TOLERANCE = 500n; // £5.00 in minor units
const AMOUNT_TOLERANCE_FRACTION = 100n; // one hundredth => 1%

/**
 * How far an amount may miss and still be "close": the greater of £5 and 1% of the
 * line, in minor units. A bank charge on the way in is a few pounds regardless of the
 * transaction size, and a percentage covers the large transfers where a fixed floor
 * would be noise. The reason carries the exact signed difference, so the client shows
 * the real number rather than this band.
 */
export function amountTolerance(lineAmount: bigint): bigint {
  const magnitude = lineAmount < 0n ? -lineAmount : lineAmount;
  const fraction = magnitude / AMOUNT_TOLERANCE_FRACTION;
  return fraction > MINIMUM_AMOUNT_TOLERANCE ? fraction : MINIMUM_AMOUNT_TOLERANCE;
}

/** Beyond this many days apart the dates no longer corroborate, so no date reason. */
export const DATE_CORROBORATION_DAYS = 7;

const MINIMUM_REFERENCE_LENGTH = 3;

/** Upper-cased and stripped to alphanumerics, so spacing and punctuation do not matter. */
export function normalizeText(value: string | null): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * The amount reason for a candidate whose amount is `candidateAmount` in the line's
 * signed frame. Exact when it agrees to the penny, close otherwise; the caller has
 * already checked the difference is within tolerance.
 */
export function amountReason(candidateAmount: bigint, lineAmount: bigint): BankMatchReason {
  const difference = candidateAmount - lineAmount;
  return {
    code: difference === 0n ? 'amount_exact' : 'amount_close',
    amountDifference: difference.toString(),
    dayDifference: null,
  };
}

/** The date reason, or null when the dates are too far apart to corroborate. */
export function dateReason(candidateDate: string, lineDate: string): BankMatchReason | null {
  const difference = dayDifference(lineDate, candidateDate);
  if (difference !== 0 && Math.abs(difference) > DATE_CORROBORATION_DAYS) return null;
  return {
    code: difference === 0 ? 'date_exact' : 'date_close',
    amountDifference: null,
    dayDifference: difference,
  };
}

const MAGNITUDELESS = { amountDifference: null, dayDifference: null } as const;

export const referenceReason: BankMatchReason = { code: 'reference_match', ...MAGNITUDELESS };
export const counterpartyReason: BankMatchReason = { code: 'counterparty_match', ...MAGNITUDELESS };
export const descriptionReason: BankMatchReason = { code: 'description_match', ...MAGNITUDELESS };
export const ruleReason: BankMatchReason = { code: 'rule_match', ...MAGNITUDELESS };
export const contactHistoryReason: BankMatchReason = { code: 'contact_history', ...MAGNITUDELESS };

/** True when the candidate's reference token appears in the line's reference/description text. */
export function referenceMatches(lineHaystack: string, candidateReference: string | null): boolean {
  const token = normalizeText(candidateReference);
  if (token.length < MINIMUM_REFERENCE_LENGTH) return false;
  return lineHaystack.includes(token);
}

/** True when two names coincide after normalisation, either as equals or as a containment. */
export function namesMatch(left: string, right: string): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return left === right || left.includes(right) || right.includes(left);
}
