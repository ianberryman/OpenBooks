/**
 * Bank rules — a deterministic classification lookup (OB-080; ROADMAP D-44,
 * acceptance E8/E9/E10).
 *
 * A rule matches on a line's description, amount and direction and proposes an
 * account, a contact and dimension tags — same line in, same proposal out, every
 * time. It is not a workflow; the outcome has three fields and none of them is a verb,
 * and M6 owns the day a fourth that *does* something is wanted (D-44).
 *
 * ## Surface
 *
 * | Operation                                | Permission      |
 * | ---------------------------------------- | --------------- |
 * | `createBankRule(input, ctx)`             | `banking.match` |
 * | `getBankRule(ruleId, ctx)`               | `banking.read`  |
 * | `listBankRules(query, ctx)`              | `banking.read`  |
 * | `updateBankRule(ruleId, input, ctx)`     | `banking.match` |
 * | `bankRuleEvaluator.evaluate(lines, ctx)` | the caller's    |
 *
 * `banking.match` is latent until this service; creating or editing a rule is the
 * first thing to enforce it, exactly as OB-078 took `banking.import` live. Reads take
 * `banking.read`, already live since wave 1.
 *
 * `bankRuleEvaluator` is the concrete `RuleEvaluator` OB-079's match engine injects
 * (`../rule-evaluator.ts`). It checks no permission of its own and takes a handle from
 * the context: it belongs to the engine's evaluation of a page, runs in the engine's
 * transaction scope, and only ever produces an outcome the engine turns into a
 * proposal — it cannot post (D-43).
 *
 * ## A rule change never reaches backwards (E8)
 *
 * There is no "re-run rules over existing lines" operation here, by decision: a rule
 * acts only when a line is evaluated for proposals. Editing or deactivating one
 * touches no posted entry and no existing line, so a rule change cannot restate last
 * quarter's coding — the property D-16 refuses for transactions arriving through a
 * side door. Deactivating is a state change that stops the rule proposing; it is not a
 * delete, so the record of why a line was once coded a certain way survives.
 */

export { createBankRule, getBankRule, listBankRules, updateBankRule } from './rules.service';

export { bankRuleEvaluator } from './evaluator';
