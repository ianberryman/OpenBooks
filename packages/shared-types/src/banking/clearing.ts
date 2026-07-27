import { z } from 'zod';

import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { ALLOCATION_TARGET_TYPES } from '../subledger';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { bankLineAmountSchema } from './banking';

/**
 * Clearing a statement line (OB-075, for OB-081; ROADMAP D-43, acceptance E3, E4).
 *
 * ## Accepting is the write, and it is the only one
 *
 * D-43: matching proposes, a human posts. Nothing in `matching.ts` reaches the
 * ledger; this file is where a ledger write happens, and it happens because someone
 * asked for it. The request carries no proposal id it is obliged to honour and no
 * "accept the best one" shorthand — a client sends what it wants done, which is the
 * same thing whether a proposal suggested it or a person typed it.
 *
 * ## The three shapes, which are OB-081's three
 *
 * - **`post_entry`** — code the line to an account. The journal is created here, for
 *   the line's own amount, dated the line's own date.
 * - **`link_entry`** — the ledger already knows. A payment recorded last week, a
 *   journal someone posted by hand: the line is evidence for an entry that exists,
 *   and clearing links them rather than posting a second one.
 * - **`allocate_document`** — the line is a customer paying an invoice or us paying
 *   a bill. This records a payment against the bank account and allocates it through
 *   M3's one mechanism (D-39), so what is outstanding keeps its single definition.
 *
 * A discriminated union rather than one object with nullable fields per shape,
 * because the invalid combinations are the ones that matter: a request that named
 * both a journal to link and an account to code to would leave the server choosing
 * what the caller meant. Here it does not parse.
 *
 * ## E4, stated as an equation
 *
 * > A cleared line and the entry it clears agree exactly on amount, and the
 * > difference is recorded.
 *
 * Which reads as a contradiction until you write it down:
 *
 * ```
 * line.amount === clearing.clearedAmount + clearing.differenceAmount
 * ```
 *
 * The two agree *because* the difference has been posted. A customer pays £1,000
 * against a £1,000 invoice and the bank takes a £10 charge on the way in: the line
 * is £990, the entry accounts for £1,000, and £10 goes to bank charges. Nothing is
 * fudged, nothing is left over, and the £10 is an expense in the books rather than a
 * rounding somebody absorbed in a spreadsheet.
 *
 * A non-zero difference with nowhere to post it is `clearing_difference_unaccounted`.
 * An equation that does not close is `clearing_amount_mismatch`.
 *
 * ## No `.meta({ id })`, and no route yet — see `banking.ts`.
 */

/**
 * The three ways a line can be cleared, which are exactly OB-081's three.
 *
 * `matching.ts` derives a proposal's kind from this list, so a proposal whose kind
 * has no way to be accepted is unrepresentable.
 */
export const BANK_CLEARING_METHODS = ['post_entry', 'link_entry', 'allocate_document'] as const;

export type BankClearingMethod = (typeof BANK_CLEARING_METHODS)[number];

export const bankClearingMethodSchema = z.enum(BANK_CLEARING_METHODS).meta({
  description:
    'How the line was accounted for: `post_entry` created a journal for it, `link_entry` pointed ' +
    'it at one that already existed, `allocate_document` recorded a payment and applied it to an ' +
    'invoice or a bill.',
});

const clearingMemoSchema = z.string().trim().max(512);

const dimensionValueIdsSchema = z
  .array(z.uuid())
  .max(MAX_DIMENSIONS_PER_ORG)
  .meta({
    description:
      'Dimension values to tag the posted line with. A value names its own axis, so an omitted ' +
      'axis is untagged — the shape every other tagged line in this API uses.',
  });

/**
 * The difference account, and why it appears on two of the three shapes.
 *
 * `post_entry` cannot have a difference: the entry is created *for the line*, so it
 * agrees by construction. The other two clear a line against an amount decided
 * elsewhere — an existing journal, or a document's outstanding balance — and those
 * are exactly the cases where a bank charge or a short payment shows up.
 */
const differenceAccountIdSchema = z
  .uuid()
  .nullish()
  .meta({
    description:
      'Where to post the difference between the line and what the entry accounts for — bank ' +
      'charges, a short payment. Required when there is a difference (E4); a difference with ' +
      'nowhere to go is `clearing_difference_unaccounted`.',
  });

/**
 * Codes the line to an account and posts the journal.
 *
 * There is no entry date. The journal is dated the line's `postedDate`, always,
 * because a reconciliation asserts a book balance *at a date* (D-45) and an entry
 * dated anywhere else would make the assertion untrue for the account it is being
 * asserted about. A line whose date falls in a closed fiscal period is therefore a
 * refusal rather than a request to pick another date — which is the opposite of
 * `voidDocumentRequestSchema`, deliberately: a void is a correction that may land
 * later, and a bank line is a fact that happened when it happened.
 */
const postEntryClearingSchema = z.strictObject({
  method: z.literal('post_entry'),
  accountId: z.uuid().meta({
    description:
      'The other side of the entry — the expense, income or balance-sheet account this line is. ' +
      'The bank account’s own ledger account is the near side and is never named here.',
  }),
  contactId: z.uuid().nullish(),
  dimensionValueIds: dimensionValueIdsSchema.optional(),
  memo: clearingMemoSchema.nullish(),
});

/**
 * Links the line to a journal that already exists.
 *
 * This is the shape that makes the statement corroborating evidence rather than a
 * second book: most of what a well-kept ledger sees on a statement is already in it,
 * and clearing says "this is that", not "post it again". A journal already linked to
 * another line is `journal_already_cleared` — one movement of money, one statement
 * line, one entry.
 */
const linkEntryClearingSchema = z.strictObject({
  method: z.literal('link_entry'),
  journalId: z.uuid().meta({
    description:
      'The posted journal this line is evidence for. Its net movement on the bank account is what ' +
      'the clearing accounts for; anything left over is the difference.',
  }),
  differenceAccountId: differenceAccountIdSchema,
  memo: clearingMemoSchema.nullish(),
});

/**
 * Records a payment for the line and applies it to an open invoice or bill.
 *
 * `amount` is a **positive magnitude**, following the M3 allocation rule that an
 * allocation is always positive and the direction carries the sign — the line's own
 * sign decides whether this is money received or paid. That is a change of frame
 * from the response below, where `clearedAmount` is signed so that E4's equation has
 * no conditional in it, and it is worth the change: an allocation that could be
 * negative would be an un-application in disguise, and M3 refused that already.
 */
const allocateDocumentClearingSchema = z.strictObject({
  method: z.literal('allocate_document'),
  targetType: z.enum(ALLOCATION_TARGET_TYPES).meta({
    description:
      'The two documents that carry an amount owed, from M3’s allocation vocabulary — an inbound ' +
      'line settles an `invoice`, an outbound one a `bill`.',
  }),
  targetId: z.uuid(),
  amount: minorUnitsSchema.nullish().meta({
    description:
      'How much of the document to settle, as a positive magnitude. Defaults to the whole of the ' +
      'line — the ordinary case, where the payment is exactly what the statement shows.',
  }),
  differenceAccountId: differenceAccountIdSchema,
  memo: clearingMemoSchema.nullish(),
});

/**
 * Accepting: the one request in this module that writes to the ledger.
 *
 * Note what is absent. There is no `proposalId` the server must honour, no
 * `acceptAll`, and no batch that would let a client sweep a statement in one call.
 * The last is the temptation D-43 exists to refuse: a bulk accept is an auto-poster
 * with a human's name on it, and "an auto-poster's mistakes land in an append-only
 * ledger where the correction is a reversing entry."
 */
export const clearBankStatementLineRequestSchema = z.discriminatedUnion('method', [
  postEntryClearingSchema,
  linkEntryClearingSchema,
  allocateDocumentClearingSchema,
]);

export type ClearBankStatementLineRequest = z.infer<typeof clearBankStatementLineRequestSchema>;

/**
 * One clearing, as the API returns it.
 *
 * `clearedAmount` and `differenceAmount` are **signed, in the line's frame**, so
 * that E4 is checkable without consulting anything else:
 * `clearedAmount + differenceAmount` equals the line's `amount`, exactly, on every
 * clearing this system will produce.
 *
 * `differenceAccountId` and `differenceJournalId` are non-null exactly when
 * `differenceAmount` is non-zero. Nullable together rather than a nested nullable
 * object, following `agingDocumentSchema`'s precedent for fields that are absent as
 * a group.
 */
export const bankLineClearingSchema = z.strictObject({
  id: z.uuid(),
  lineId: z.uuid(),
  method: bankClearingMethodSchema,
  clearedJournalId: z.uuid().meta({
    description:
      'The journal that accounts for this line — created by `post_entry`, named by `link_entry`, ' +
      'or the payment’s own under `allocate_document`.',
  }),
  clearedAmount: bankLineAmountSchema.meta({
    description:
      'What the entry accounts for, signed in the line’s frame. Equal to the line’s `amount` ' +
      'unless a difference was recorded.',
  }),
  differenceAmount: bankLineAmountSchema.meta({
    description:
      '`line.amount − clearedAmount`, exactly. Zero on almost every clearing; non-zero is a bank ' +
      'charge or a short payment, and it has been posted, not absorbed (E4).',
  }),
  differenceAccountId: z.uuid().nullable(),
  differenceJournalId: z.uuid().nullable(),
  paymentId: z.uuid().nullable().meta({
    description: 'The payment recorded by an `allocate_document` clearing. Null for the other two.',
  }),
  reconciliationSessionId: z
    .uuid()
    .nullable()
    .meta({
      description:
        'The session that counted this clearing, once one has. Null while none has — clearing a ' +
        'line and reconciling a period are separate acts, and a business may code its statement ' +
        'as it goes and reconcile at month end.',
    }),
  clearedByUserId: z.uuid().meta({
    description:
      'Who accepted. The human D-43 requires: every ledger write on this path is a decision ' +
      'somebody made, and this is where it is recorded.',
  }),
  clearedAt: z.iso.datetime(),
});

export type BankLineClearing = z.infer<typeof bankLineClearingSchema>;

/**
 * Undoing a clearing.
 *
 * The link is removed and, where this clearing posted a journal, that journal is
 * reversed — never deleted (D-16, spec §2.2). `date` is the reversal's own entry
 * date and must itself fall in an open period, which is `voidDocumentRequestSchema`'s
 * argument and applies here for the same reason: by the time somebody notices a
 * mis-accepted proposal, the line's own month is often closed.
 *
 * A `link_entry` clearing posts nothing to reverse unless it recorded a difference,
 * so `date` is unused in that case rather than forbidden — a shape that varied by
 * the method being undone would make a client look up the method before it could
 * undo it.
 *
 * Undoing a clearing counted by a finalised session is
 * `reconciliation_session_already_finalised`. The session is what makes the
 * assertion, and an assertion whose evidence can be withdrawn afterwards asserts
 * nothing (E6 — reopening is permission-gated and recorded, and it is the way in).
 */
export const removeBankLineClearingRequestSchema = z.strictObject({
  date: calendarDateSchema.meta({
    description: 'The reversal’s own entry date, which must fall in an open fiscal period.',
  }),
  memo: clearingMemoSchema.nullish(),
});

export type RemoveBankLineClearingRequest = z.infer<typeof removeBankLineClearingRequestSchema>;
