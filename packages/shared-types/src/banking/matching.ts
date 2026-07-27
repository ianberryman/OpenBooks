import { z } from 'zod';

import { ALLOCATION_TARGET_TYPES } from '../subledger';
import { calendarDateSchema, minorUnitsSchema, PAGE_SIZE_MAX } from '../wire';

import { bankLineAmountSchema } from './banking';
import { BANK_CLEARING_METHODS } from './clearing';

/**
 * Match proposals (OB-075, for OB-079; ROADMAP D-43, acceptance E3).
 *
 * ## Matching proposes; a human posts
 *
 * E3 is the criterion, D-43 is the argument, and this file is the half of the
 * pipeline that has no way to write. Everything here is a response: ranked
 * candidates, each carrying a reason a client can display. Accepting one is
 * `clearing.ts`, a separate request, made by a person.
 *
 * D-43 is worth quoting because the shape follows from it: "a bank statement is the
 * one input a bookkeeping system takes from outside itself, and an auto-poster's
 * mistakes land in an append-only ledger where the correction is a reversing entry —
 * so a matcher confident enough to post is a matcher that manufactures journal pairs
 * when it is wrong."
 *
 * So there is **no auto-post shape anywhere in this module**: no `autoAccept`, no
 * `confidenceThreshold` above which the server acts, no batch accept. There is not
 * even a confidence *score* — see `rank` below. `contracts.test.ts` asserts the
 * absence, because this is a decision that erodes by one plausible field at a time.
 *
 * ## A proposal is cheap and disposable
 *
 * D-43's corollary. Nothing depends on a proposal being right, only on it being
 * ranked well, "which is what lets the ranking be improved later without a
 * migration". Proposals therefore carry no state, no acceptance flag and no
 * lifecycle: they are computed for the lines a screen is showing, and a better
 * ranking next month simply returns a different order.
 *
 * ## No `.meta({ id })`, and no route yet — see `banking.ts`.
 */

/**
 * What a proposal is proposing, which is exactly what accepting it would do.
 *
 * Derived from `BANK_CLEARING_METHODS` rather than restated, so a kind with no way
 * to be accepted cannot be expressed: the union in `clearing.ts` and the union here
 * are the same three, by construction, and a fourth added to one appears in the
 * other as a type error.
 */
export const BANK_MATCH_KINDS = BANK_CLEARING_METHODS;

export type BankMatchKind = (typeof BANK_MATCH_KINDS)[number];

/**
 * Why this candidate was proposed — the part a client shows the user.
 *
 * A vocabulary of tokens rather than a sentence from the server, for the reason
 * every other token in this API is a token: prose is not branchable, not
 * translatable, and not something a screen can render as an icon. The client owns
 * the wording; the server owns the fact.
 */
export const BANK_MATCH_REASON_CODES = [
  'amount_exact',
  'amount_close',
  'date_exact',
  'date_close',
  'reference_match',
  'counterparty_match',
  'description_match',
  'rule_match',
  'contact_history',
] as const;

export type BankMatchReasonCode = (typeof BANK_MATCH_REASON_CODES)[number];

export const bankMatchReasonCodeSchema = z.enum(BANK_MATCH_REASON_CODES).meta({
  description:
    'Why the candidate was proposed. A token and not a sentence: the client owns the wording, ' +
    'the server owns the fact.',
});

/**
 * One reason, with the numbers behind it where there are any.
 *
 * `amountDifference` and `dayDifference` carry what "close" meant, rather than the
 * server phrasing it: "£0.03 more" and "3 days earlier" are formatting decisions a
 * screen makes with the user's locale in hand. They are null on the reasons that
 * have no magnitude — a reference either matched or it did not.
 *
 * `amountDifference` is money and therefore a cents-only string (D-13), signed in
 * the statement line's frame like every other amount in this module.
 */
export const bankMatchReasonSchema = z.strictObject({
  code: bankMatchReasonCodeSchema,
  amountDifference: bankLineAmountSchema.nullable().meta({
    description: 'How far off the amounts were, signed. Null where the reason is not about amount.',
  }),
  dayDifference: z
    .int()
    .nullable()
    .meta({
      description:
        'How far apart the dates were, in days, negative when the candidate is earlier. Null ' +
        'where the reason is not about date.',
    }),
});

export type BankMatchReason = z.infer<typeof bankMatchReasonSchema>;

/**
 * What every proposal carries, whatever it proposes.
 *
 * `rank` is where confidence lives, and there is deliberately no score beside it.
 * D-43 puts confidence "in the ordering of proposals, not in the decision to write",
 * and a numeric score invites exactly the field this module refuses: once a client
 * can read `0.97`, somebody writes a setting that accepts everything above `0.95`,
 * and the auto-poster is back with a slider in front of it. An ordering says which
 * candidate is best without claiming to know how sure it is.
 */
const proposalCommonShape = {
  id: z.uuid().meta({
    description:
      'Identifies this candidate within the response. A proposal is computed, not stored (D-43), ' +
      'so this is not a handle to fetch later — accepting names what to do, not which proposal ' +
      'said to do it.',
  }),
  lineId: z.uuid(),
  rank: z
    .int()
    .min(1)
    .meta({
      description:
        'Position in the ranking, 1 first. There is no confidence score: D-43 puts confidence in ' +
        'the ordering rather than in a decision to write, and a score is the field an auto-accept ' +
        'threshold is eventually built on.',
    }),
  reasons: z.array(bankMatchReasonSchema).min(1).meta({
    description: 'Why this was proposed. Never empty — a candidate with no reason is noise.',
  }),
};

/**
 * Code the line to an account — usually because a rule said so (D-44), sometimes
 * because this org has coded a line like it before.
 *
 * `ruleId` is null in the second case, and the distinction is worth carrying: "your
 * rule says groceries" and "you called the last one groceries" are different claims,
 * and only one of them is something the user can go and edit.
 */
const postEntryProposalSchema = z.strictObject({
  ...proposalCommonShape,
  kind: z.literal('post_entry'),
  accountId: z.uuid(),
  contactId: z.uuid().nullable(),
  dimensionValueIds: z.array(z.uuid()),
  ruleId: z.uuid().nullable().meta({
    description: 'The rule that produced this, or null when it came from the org’s own history.',
  }),
});

/** The ledger already knows: an entry that looks like this line, not yet linked to one. */
const linkEntryProposalSchema = z.strictObject({
  ...proposalCommonShape,
  kind: z.literal('link_entry'),
  journalId: z.uuid(),
  journalDate: calendarDateSchema,
  journalMemo: z.string().nullable(),
  journalAmount: bankLineAmountSchema.meta({
    description:
      'The candidate journal’s net movement on this bank account, signed in the line’s frame — so ' +
      'the client can show the difference without arithmetic of its own.',
  }),
});

/** An open invoice or bill this line looks like a settlement of. */
const allocateDocumentProposalSchema = z.strictObject({
  ...proposalCommonShape,
  kind: z.literal('allocate_document'),
  targetType: z.enum(ALLOCATION_TARGET_TYPES),
  targetId: z.uuid(),
  documentNumber: z.string().nullable(),
  contactId: z.uuid(),
  contactName: z.string().meta({
    description:
      'Carried rather than resolved by the client, for the reason the aging report carries it: a ' +
      'screen showing a few hundred proposals would otherwise fetch a few hundred contacts.',
  }),
  outstanding: minorUnitsSchema.meta({
    description:
      'What is still owed on the document, computed on read (D-34). What the payment would settle ' +
      'unless the user says otherwise.',
  }),
});

export const bankMatchProposalSchema = z.discriminatedUnion('kind', [
  postEntryProposalSchema,
  linkEntryProposalSchema,
  allocateDocumentProposalSchema,
]);

export type BankMatchProposal = z.infer<typeof bankMatchProposalSchema>;

/**
 * The most candidates one line is ever given.
 *
 * Ten, because the list is read by a person deciding, not by a program scoring: past
 * the first handful, another plausible-looking row makes the decision slower rather
 * than better. It also bounds the response of the milestone's heaviest screen (E10 —
 * a 5,000-line statement without pathological behaviour).
 */
export const BANK_MATCH_PROPOSALS_PER_LINE = 10;

/**
 * One line's ranked candidates, best first.
 *
 * An empty array is an ordinary answer and not an error: most statements contain
 * lines nothing in the books resembles, and that is what the coding screen is for.
 */
export const bankLineProposalsSchema = z.strictObject({
  lineId: z.uuid(),
  proposals: z.array(bankMatchProposalSchema).max(BANK_MATCH_PROPOSALS_PER_LINE),
});

export type BankLineProposals = z.infer<typeof bankLineProposalsSchema>;

/**
 * Proposals for the lines a screen is showing.
 *
 * Named lines rather than a filter over the account, so the response is bounded by
 * the request rather than by the org's data — `createAllocationsRequestSchema`'s
 * argument, and here it is also E10's: OB-086 shows a page of a statement and needs
 * that page's proposals in one round trip, not one per row and not all five thousand.
 *
 * Bounded by `PAGE_SIZE_MAX` so a request cannot ask for proposals over more lines
 * than a page of lines can contain.
 */
export const bankMatchProposalsRequestSchema = z.strictObject({
  lineIds: z.array(z.uuid()).min(1).max(PAGE_SIZE_MAX),
});

export type BankMatchProposalsRequest = z.infer<typeof bankMatchProposalsRequestSchema>;

/**
 * An envelope rather than a bare array, for `allocationListSchema`'s reason: a
 * top-level object has somewhere to put a later addition and a top-level JSON array
 * has nowhere at all.
 *
 * Not `pageSchema`: this is not a list of what exists, it is the answer to one
 * question about a named set of lines, and a `nextCursor` that is always null would
 * invite a client to page it.
 */
export const bankMatchProposalListSchema = z.strictObject({
  lines: z.array(bankLineProposalsSchema),
});

export type BankMatchProposalList = z.infer<typeof bankMatchProposalListSchema>;
