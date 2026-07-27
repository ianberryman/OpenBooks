import { z } from 'zod';

import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { minorUnitsSchema, pageQueryShape } from '../wire';

import { bankLineDirectionSchema, unpublishedPageSchema } from './banking';

/**
 * Bank rules (OB-075, for OB-080; ROADMAP D-44, acceptance E8).
 *
 * ## A lookup, not an engine
 *
 * D-44: match on description, amount and direction; set an account, a contact and
 * dimension tags. Same input, same proposal, every time.
 *
 * M6 owns the workflow engine, and the temptation is to make bank rules its first
 * consumer so the action catalog gets designed once. D-44 refuses, and the reason is
 * not sequencing: "a bank rule answers *what is this line*, which is classification,
 * while a workflow answers *what should happen next*, which is orchestration." So
 * the outcome below is called an outcome and not an action, it has three fields, and
 * none of them is a verb. If a wave-2 ticket finds itself wanting a fourth that
 * *does* something, that is the signal to stop and ask, because it is M6's decision
 * arriving early.
 *
 * ## A rule proposes; it still never posts (D-43, E3)
 *
 * A matched rule produces a `bankMatchProposal` like any other candidate — a
 * particularly confident one, ranked accordingly. It does not clear a line. The two
 * decisions compose: D-44 makes classification deterministic, D-43 keeps the write
 * a human's.
 *
 * ## A rule change never restates a posted entry (E8)
 *
 * Rules act on proposals only, and a proposal is evaluated when a line is looked at.
 * Nothing here reaches backwards. If it did, editing a rule would silently rewrite
 * last quarter's coding — the property D-16 refuses for transactions arriving
 * through a side door. There is consequently no "re-run rules over existing lines"
 * shape in this file, and adding one would need an answer to what it does to lines
 * that are already cleared.
 *
 * ## No `.meta({ id })`, and no route yet — see `banking.ts`.
 */

export const BANK_RULE_NAME_MAX_LENGTH = 120;
export const BANK_RULE_MATCH_VALUE_MAX_LENGTH = 255;

/**
 * How a rule compares its text against a line's description.
 *
 * Three literal comparisons and no regular expression. A regex is a program: it can
 * be catastrophically slow on adversarial input, it is not something a bookkeeper
 * can read six months later to work out why a line was coded to the wrong account,
 * and "same input, same proposal, every time" stops being obvious the moment the
 * predicate is Turing-shaped. The three below cover what bank narratives actually
 * need, which is a merchant name appearing somewhere in a string the bank pads with
 * its own noise.
 *
 * Comparison is case-insensitive: banks are not consistent about case even between
 * two rows of one file, and a rule that matched `TESCO` but not `Tesco` would be a
 * rule that appears broken at random.
 */
export const BANK_RULE_MATCH_MODES = ['contains', 'equals', 'starts_with'] as const;

export type BankRuleMatchMode = (typeof BANK_RULE_MATCH_MODES)[number];

export const bankRuleMatchModeSchema = z.enum(BANK_RULE_MATCH_MODES).meta({
  description:
    'How the rule’s text is compared against the line’s description, case-insensitively. No ' +
    'regular expressions: a regex is a program, and a rule nobody can read is a coding decision ' +
    'nobody can audit.',
});

const bankRuleTextMatchSchema = z.strictObject({
  mode: bankRuleMatchModeSchema,
  value: z.string().trim().min(1).max(BANK_RULE_MATCH_VALUE_MAX_LENGTH),
});

/**
 * What a rule matches on. Every field is optional; at least one must be present.
 *
 * The refinement matters more than it looks: a rule with an empty condition matches
 * every line on the account, and the first thing it would do is out-rank every
 * genuine proposal on a statement. Refusing it here means the failure is a message
 * at the moment somebody saves the rule, rather than a screenful of wrong
 * suggestions the next morning.
 *
 * `amountMin`/`amountMax` are compared against the line's **signed** amount, so an
 * outbound rule bounded at `-5000` and `-100` reads the way the number line does.
 * Bounds rather than an exact amount because the useful case is a range — a
 * subscription that drifts by a few pence, a card fee under a pound — and an exact
 * amount is a range with equal ends.
 */
export const bankRuleConditionSchema = z
  .strictObject({
    description: bankRuleTextMatchSchema.nullish(),
    direction: bankLineDirectionSchema.nullish(),
    amountMin: minorUnitsSchema.nullish().meta({
      description: 'Inclusive lower bound on the line’s signed amount.',
    }),
    amountMax: minorUnitsSchema.nullish().meta({
      description: 'Inclusive upper bound on the line’s signed amount.',
    }),
    bankAccountId: z
      .uuid()
      .nullish()
      .meta({
        description:
          'Restrict the rule to one bank account. Null means every account — right for “Tesco is ' +
          'groceries”, wrong for a rule about a specific card’s annual fee.',
      }),
  })
  .refine(
    (condition) => Object.values(condition).some((value) => value !== undefined && value !== null),
    {
      error: 'A rule must match on something — an empty condition matches every line.',
      path: ['description'],
    },
  );

export type BankRuleCondition = z.infer<typeof bankRuleConditionSchema>;

/**
 * What a matched rule proposes. Three fields, and none of them is a verb.
 *
 * `accountId` is required: classification is what a rule is for, and a rule that set
 * only a contact would be a rule whose proposal still cannot be accepted without the
 * user answering the one question that matters.
 */
export const bankRuleOutcomeSchema = z.strictObject({
  accountId: z.uuid().meta({
    description: 'The account to code the line to. The whole point of the rule.',
  }),
  contactId: z.uuid().nullish(),
  dimensionValueIds: z.array(z.uuid()).max(MAX_DIMENSIONS_PER_ORG).optional(),
});

export type BankRuleOutcome = z.infer<typeof bankRuleOutcomeSchema>;

/**
 * A rule as the API returns it.
 *
 * `priority` is what makes "same input, same proposal, every time" true when two
 * rules both match: lower runs first, and first match wins. Ties are broken by
 * `createdAt` and then `id`, so the order is total and does not depend on how the
 * database happened to return the rows — a deterministic lookup whose result depends
 * on a scan order is not deterministic, it is merely usually stable.
 */
export const bankRuleSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  priority: z.int().meta({
    description:
      'Lower runs first, and the first matching rule wins. Ties break on `createdAt` then `id`, ' +
      'so the ordering is total — a lookup whose answer depends on scan order is not ' +
      'deterministic (D-44).',
  }),
  isActive: z.boolean().meta({
    description:
      'An inactive rule proposes nothing and is not deleted. Deactivating rather than deleting ' +
      'keeps the record of why a line was coded the way it was, which is the question a rule ' +
      'gets asked about months later.',
  }),
  condition: bankRuleConditionSchema,
  outcome: bankRuleOutcomeSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type BankRule = z.infer<typeof bankRuleSchema>;

const ruleNameSchema = z.string().trim().min(1).max(BANK_RULE_NAME_MAX_LENGTH);

export const createBankRuleRequestSchema = z.strictObject({
  name: ruleNameSchema,
  priority: z.int().optional().meta({
    description:
      'Defaults to the end of the list, so a new rule cannot silently pre-empt an old one.',
  }),
  condition: bankRuleConditionSchema,
  outcome: bankRuleOutcomeSchema,
});

export type CreateBankRuleRequest = z.infer<typeof createBankRuleRequestSchema>;

/**
 * `condition` and `outcome` are each replaced whole rather than patched, for
 * `updateBankImportMappingRequestSchema`'s reason: a condition's fields are
 * interdependent — at least one must be present — so a patch would let a caller
 * reach an empty condition one field at a time.
 *
 * `isActive` is here, unlike on the other update requests in this module.
 * Deactivating a rule refuses nothing and cascades to nothing: it stops future
 * proposals and touches no posted entry, which is E8 restated. There is nothing for
 * a separate operation to guard.
 */
export const updateBankRuleRequestSchema = z
  .strictObject({
    name: ruleNameSchema.optional(),
    priority: z.int().optional(),
    isActive: z.boolean().optional(),
    condition: bankRuleConditionSchema.optional(),
    outcome: bankRuleOutcomeSchema.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Supply at least one field to change.',
  });

export type UpdateBankRuleRequest = z.infer<typeof updateBankRuleRequestSchema>;

export const listBankRulesQuerySchema = z.strictObject({
  ...pageQueryShape,
  isActive: z.boolean().optional(),
  bankAccountId: z.uuid().optional(),
});

/** The *input* type: `limit` carries a `.default()`, so parsed output differs. */
export type ListBankRulesQuery = z.input<typeof listBankRulesQuerySchema>;

/**
 * Ordered by `(priority, created_at, id)` — the evaluation order, and the only
 * ordering a rule list is ever read in.
 *
 * The keyset is stable under the usual objection because `priority` is editable:
 * reordering rules while paging them can move a row behind the cursor. Accepted
 * deliberately, unlike everywhere else in this API, because the alternative is a
 * screen that lists rules in an order they are not evaluated in — which is the one
 * thing a rules screen must not do.
 */
export const bankRulePageSchema = unpublishedPageSchema(bankRuleSchema);

export type BankRulePage = z.infer<typeof bankRulePageSchema>;
