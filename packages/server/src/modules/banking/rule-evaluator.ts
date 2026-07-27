/**
 * The seam between bank rules and the match engine (OB-079, OB-080; ROADMAP D-43,
 * D-44, acceptance E3, E8).
 *
 * The match engine ranks candidates for a statement line; a rule is one source of
 * them — a particularly confident `post_entry` proposal carrying `rule_match`. But
 * the engine and the rules are two tickets, deliberately parallel (both depend only
 * on OB-078), so the engine must not import the rules service. It consumes a
 * `RuleEvaluator` handed to it, exactly as the statement service consumes a
 * `StatementParseFn`, and OB-080 supplies the concrete one at the composition point.
 *
 * The direction of the dependency is the point. A rule proposes and never posts
 * (D-43, E8): its result is an *outcome* the engine turns into a proposal, and the
 * decision to write stays a human's in `clearing.ts`. Putting the evaluator behind
 * this interface keeps that legible — nothing a rule returns can reach the ledger,
 * because the type it returns has no way to.
 *
 * Batched by design: a page of a statement is evaluated at once so OB-080 loads the
 * account's active rules a single time and applies them across the page, which is
 * E10's constraint (a 5,000-line statement without pathological behaviour) rather
 * than a convenience.
 */

import type { RequestContext } from '../../context';

/**
 * The facts a rule matches against, per line. Everything a `bankRuleConditionSchema`
 * reads: the description, the signed amount (its sign is the direction), and the
 * account, since a rule may be scoped to one. The engine already holds these on the
 * statement line rows; the evaluator needs nothing it does not.
 */
export interface RuleCandidateLine {
  readonly lineId: string;
  readonly bankAccountId: string;
  readonly description: string;
  readonly amount: bigint;
}

/**
 * The winning rule for a line, and what it says to do — the deterministic
 * first-match-by-priority result (D-44). `accountId` is always present because a
 * rule that classified nothing would be a rule whose proposal cannot be accepted;
 * the other two are the rule's optional outcome fields.
 *
 * This is an outcome, not an action. It names a coding, not a verb — the distinction
 * D-44 draws between classification and the orchestration M6 owns.
 */
export interface RuleMatch {
  readonly ruleId: string;
  readonly accountId: string;
  readonly contactId: string | null;
  readonly dimensionValueIds: readonly string[];
}

/**
 * Evaluate the active rules against a page of lines, returning the winning match per
 * line that matched one. A line absent from the map matched no rule, which is the
 * ordinary case — most lines are coded by hand or by history, not by a rule.
 */
export interface RuleEvaluator {
  evaluate(
    lines: readonly RuleCandidateLine[],
    ctx: RequestContext,
  ): Promise<ReadonlyMap<string, RuleMatch>>;
}
