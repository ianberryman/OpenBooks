import type { BankRuleMatchMode } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { TenantDatabase } from '../../../db';
import { bufferToUuid } from '../../../db';
import type { RuleCandidateLine, RuleEvaluator, RuleMatch } from '../rule-evaluator';

import {
  orgScope,
  selectActiveRules,
  selectRuleDimensionsFor,
  type RuleRow,
} from './rules.repository';

/**
 * The concrete `RuleEvaluator` the match engine injects (OB-080 for OB-079; ROADMAP
 * D-44, acceptance E8/E10).
 *
 * The engine ranks candidates for a statement line and consumes this evaluator as one
 * source of them, exactly as the statement service consumes a `StatementParseFn`
 * (`rule-evaluator.ts`). It hands the evaluator a page of lines and gets back the
 * winning rule per matched line; it never imports the rules service, so nothing a
 * rule returns can reach the ledger — the type it returns has no way to (D-43).
 *
 * ## Determinism is the product, and it is a property of this file, not of a query
 *
 * Two rules can match one line. Which one wins must be the same answer every time,
 * whatever order the database returned the rows in — "a lookup whose answer depends on
 * scan order is not deterministic, it is merely usually stable" (D-44). The order is
 * `(priority, created_at, id)`, low priority first, first match wins. `selectActiveRules`
 * asks the database for that order so the read is an index range, and
 * `evaluatePage` sorts the rules *again* by the same comparator before matching — so
 * the winner is invariant even if the rows arrive shuffled. `evaluatePage` is exported
 * for exactly that test: permuting its input must not move a single winner.
 *
 * ## Batched (E10)
 *
 * The active rules and their tags are read once, then applied across the whole page in
 * memory. A 5,000-line statement is one rules read and one tags read, not one per
 * line. All active rules in the org are loaded, not one account's: a page may span
 * accounts, and each rule's own `bank_account_id` scope is applied per line.
 */

/**
 * An active rule in the form the matcher needs: its ordering key, its scope, its
 * predicates, and the `RuleMatch` it yields when it wins — precomputed so matching a
 * line to an outcome is a lookup, not a conversion.
 */
export interface LoadedRule {
  readonly id: Buffer;
  readonly priority: number;
  readonly createdAt: Date;
  /** `null` means every account; otherwise the rule matches only this account's lines. */
  readonly bankAccountId: string | null;
  readonly description: { readonly mode: BankRuleMatchMode; readonly needleLower: string } | null;
  readonly direction: 'inbound' | 'outbound' | null;
  readonly amountMin: bigint | null;
  readonly amountMax: bigint | null;
  readonly match: RuleMatch;
}

/**
 * The total order `(priority, created_at, id)` (D-44).
 *
 * `priority` first, low wins. `created_at` is `DATETIME(3)`, so `getTime()` is exact to
 * the millisecond the column stores. `id` is the final tiebreaker, compared as its
 * stored bytes — `Buffer.compare` is byte-wise, which is the order MySQL's `BINARY(16)`
 * comparison uses, so the two never disagree at a boundary.
 */
export function compareRules(a: LoadedRule, b: LoadedRule): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  return Buffer.compare(a.id, b.id);
}

/**
 * Whether a rule's conditions all hold for a line. Every present condition is an AND;
 * an absent one imposes nothing.
 *
 * Text comparison folds case in TS, not SQL: the rules are already in memory for the
 * page, so `toLowerCase()` here is one comparison per rule-line pair with no round
 * trip, and it makes case-insensitivity a property of the matcher independent of the
 * line's storage collation — `TESCO` matches `Tesco` because both fold, not because a
 * column happened to be declared `_ci`. `toLowerCase()` and not `toLocaleLowerCase()`,
 * so the fold is locale-independent and the same everywhere the evaluator runs.
 *
 * `descriptionLower` is the line's description folded once by the caller, so a page's
 * worth of rules does not re-fold it per rule.
 */
function ruleMatches(rule: LoadedRule, line: RuleCandidateLine, descriptionLower: string): boolean {
  if (rule.bankAccountId !== null && rule.bankAccountId !== line.bankAccountId) return false;

  if (rule.description !== null) {
    const needle = rule.description.needleLower;
    switch (rule.description.mode) {
      case 'contains':
        if (!descriptionLower.includes(needle)) return false;
        break;
      case 'equals':
        if (descriptionLower !== needle) return false;
        break;
      case 'starts_with':
        if (!descriptionLower.startsWith(needle)) return false;
        break;
    }
  }

  // The sign is the direction (`0006_banking`): inbound is a positive amount, outbound
  // a negative one, strictly — a zero-amount line is in neither.
  if (rule.direction === 'inbound' && !(line.amount > 0n)) return false;
  if (rule.direction === 'outbound' && !(line.amount < 0n)) return false;

  // Signed bounds, inclusive: an outbound rule bounded at -5000 … -100 reads the way
  // the number line does, which is why there is no `abs` anywhere here.
  if (rule.amountMin !== null && line.amount < rule.amountMin) return false;
  if (rule.amountMax !== null && line.amount > rule.amountMax) return false;

  return true;
}

/**
 * The winning match per line that matched a rule. A line absent from the map matched
 * none, the ordinary case.
 *
 * Pure and total: the rules are sorted by `compareRules` here rather than trusted to
 * arrive sorted, so this function's result is invariant under any permutation of its
 * input — which is what makes the determinism property testable without a database.
 */
export function evaluatePage(
  rules: readonly LoadedRule[],
  lines: readonly RuleCandidateLine[],
): Map<string, RuleMatch> {
  const ordered = [...rules].sort(compareRules);
  const result = new Map<string, RuleMatch>();

  for (const line of lines) {
    const descriptionLower = line.description.toLowerCase();
    const winner = ordered.find((rule) => ruleMatches(rule, line, descriptionLower));
    if (winner !== undefined) result.set(line.lineId, winner.match);
  }

  return result;
}

function toLoadedRule(row: RuleRow, dimensionValueIds: readonly Buffer[]): LoadedRule {
  return {
    id: row.id,
    priority: row.priority,
    createdAt: row.created_at,
    bankAccountId: row.bank_account_id === null ? null : bufferToUuid(row.bank_account_id),
    description:
      row.match_description === null || row.match_description_mode === null
        ? null
        : { mode: row.match_description_mode, needleLower: row.match_description.toLowerCase() },
    direction: row.match_direction,
    amountMin: row.match_amount_min_minor,
    amountMax: row.match_amount_max_minor,
    match: {
      ruleId: bufferToUuid(row.id),
      accountId: bufferToUuid(row.set_account_id),
      contactId: row.set_contact_id === null ? null : bufferToUuid(row.set_contact_id),
      dimensionValueIds: dimensionValueIds.map(bufferToUuid),
    },
  };
}

async function loadActiveRules(db: TenantDatabase): Promise<readonly LoadedRule[]> {
  const rows = await selectActiveRules(db);
  if (rows.length === 0) return [];

  const dims = await selectRuleDimensionsFor(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toLoadedRule(row, dims.get(row.id.toString('hex')) ?? []));
}

/**
 * The evaluator OB-079 injects. It derives the tenant handle from the context — which
 * joins the engine's open transaction in the same async scope
 * (`src/db/transaction-scope.ts`), so the rules are read in the same read view the
 * page is being evaluated in.
 */
export const bankRuleEvaluator: RuleEvaluator = {
  async evaluate(
    lines: readonly RuleCandidateLine[],
    ctx: RequestContext,
  ): Promise<ReadonlyMap<string, RuleMatch>> {
    if (lines.length === 0) return new Map();

    const rules = await loadActiveRules(orgScope(ctx));
    return evaluatePage(rules, lines);
  },
};
