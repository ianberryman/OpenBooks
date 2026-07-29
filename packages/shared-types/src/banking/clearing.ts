import { z } from 'zod';

import { MAX_DIMENSIONS_PER_ORG } from '../dimensions';
import { allocationTargetTypeSchema } from '../subledger';
import { calendarDateSchema, minorUnitsSchema } from '../wire';

import { bankLineAmountSchema } from './banking';

/**
 * Clearing a statement line (OB-075, for OB-081 and OB-137; ROADMAP D-43, D-80,
 * D-105, D-106, acceptance E3, E4).
 *
 * ## Accepting is the write, and it is the only one
 *
 * D-43: matching proposes, a human posts. Nothing in `matching.ts` reaches the
 * ledger; this file is where a ledger write happens, and it happens because someone
 * asked for it. The request carries no proposal id it is obliged to honour and no
 * "accept the best one" shorthand — a client sends what it wants done, which is the
 * same thing whether a proposal suggested it or a person typed it.
 *
 * ## One clear, N entries — D-80, D-105
 *
 * A clear used to be exactly one of three shapes. D-80 generalises it to an
 * **array of entries**: a lockbox deposit settling three customers' invoices in one
 * accepted action, one line coded across several accounts (the deferred OB-094
 * split, now subsumed), or a document settled partly by cash and partly by an
 * early-pay discount. `entries` is `.min(1)`, so the single-target case that was
 * the whole of OB-081 is simply `entries: [oneEntry]` — every existing caller's
 * shape, wrapped.
 *
 * - **`post_entry`** — code (part of) the line to an account. The journal is
 *   created here, dated the line's own date.
 * - **`link_entry`** — the ledger already knows. A payment recorded last week, a
 *   journal someone posted by hand: the line is evidence for an entry that exists,
 *   and clearing links them rather than posting a second one.
 * - **`allocate_document`** — (part of) the line is a customer paying an invoice or
 *   us paying a bill. This records a payment against the bank account and allocates
 *   it through M3's one mechanism (D-39), so what is outstanding keeps its single
 *   definition.
 * - **`discount`** — an early-pay discount (D-79, D-106): posts the discount
 *   journal to a nominated account and allocates the discount amount against the
 *   named document, so `outstanding` reaches zero without cash for the discounted
 *   portion. Never auto-suggested by this file — a later leaf (OB-138) computes
 *   the amount from a payment term; this is the shape the operator's confirmed
 *   entry takes.
 *
 * A discriminated union rather than one object with nullable fields per shape,
 * because the invalid combinations are the ones that matter: an entry that named
 * both a journal to link and an account to code to would leave the server choosing
 * what the caller meant. Here it does not parse.
 *
 * ## E4, generalised
 *
 * > A cleared line and the entries that clear it agree exactly on amount, and the
 * > difference is recorded.
 *
 * ```
 * line.amount === Σ(entry.amount, over every entry but `discount`) + clearing.differenceAmount
 * ```
 *
 * `discount` is the deliberate exception: D-106 funds it from the discount journal,
 * not from the line's own cash, so it never counts toward what the *line* has to
 * add up to — it settles the *document* instead, through its own allocation. A
 * customer paying £1,000 against a £1,000 invoice, taking a 2% early-pay discount,
 * makes a bank deposit of £980: one `allocate_document` entry for £980 and one
 * `discount` entry for £20, and the £980 is the whole of what the line has to
 * explain.
 *
 * A non-zero difference with nowhere to post it is `clearing_difference_unaccounted`.
 * An equation that does not close is `clearing_amount_mismatch`.
 *
 * `differenceAccountId` moved off the individual `link_entry`/`allocate_document`
 * shapes and onto the request as a whole: D-105 keeps the difference on the
 * **parent** clearing, a fact about the whole line rather than about any one
 * entry, so there is exactly one place on the wire to name where it posts.
 *
 * ## The component ids arrived with OB-084's routes — see `banking.ts`.
 */

/**
 * The three ways a proposal maps onto an entry, which are exactly OB-081's three.
 *
 * `matching.ts` derives a proposal's kind from this list, so a proposal whose kind
 * has no way to be accepted is unrepresentable. Matching never proposes a
 * `discount` — that is a human or a later suggestion leaf's addition, never a
 * ranked candidate from the bank-feed engine — so this stays the three it always
 * was rather than widening to `BANK_CLEARING_ENTRY_TYPES` below.
 */
export const BANK_CLEARING_METHODS = ['post_entry', 'link_entry', 'allocate_document'] as const;

export type BankClearingMethod = (typeof BANK_CLEARING_METHODS)[number];

export const bankClearingMethodSchema = z.enum(BANK_CLEARING_METHODS).meta({
  description:
    'How the line was accounted for: `post_entry` created a journal for it, `link_entry` pointed ' +
    'it at one that already existed, `allocate_document` recorded a payment and applied it to an ' +
    'invoice or a bill.',
});

/**
 * Every entry a multi-entry clear may contain — `BANK_CLEARING_METHODS` plus
 * `discount` (D-80, D-106). The response's per-entry `entryType` uses this wider
 * set; a proposal's `kind` uses the narrower one above.
 */
export const BANK_CLEARING_ENTRY_TYPES = [...BANK_CLEARING_METHODS, 'discount'] as const;

export type BankClearingEntryType = (typeof BANK_CLEARING_ENTRY_TYPES)[number];

export const bankClearingEntryTypeSchema = z.enum(BANK_CLEARING_ENTRY_TYPES).meta({
  description:
    'How one entry of a clear was accounted for: the three `BankClearingMethod`s, plus `discount` ' +
    '— an early-pay discount, funded by its own journal rather than by cash (D-106).',
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
 * The difference account — named once, on the request as a whole (D-105).
 *
 * `post_entry` and `discount` never leave a difference on their own — a
 * `post_entry` entry posts for exactly the amount it names, and a `discount`
 * settles a document rather than the line — so this is asked for once, alongside
 * `entries`, and applies to whatever residual the whole set leaves against the
 * line.
 */
const differenceAccountIdSchema = z
  .uuid()
  .nullish()
  .meta({
    description:
      'Where to post the difference between the line and what the entries account for — bank ' +
      'charges, a short payment. Required when there is a difference (E4); a difference with ' +
      'nowhere to go is `clearing_difference_unaccounted`.',
  });

/**
 * An entry's magnitude, as a positive number of minor units.
 *
 * Optional and defaulting to the whole of the line **only when this is the
 * request's only entry** — the single-target case OB-081 shipped, preserved
 * exactly. A genuine split (two or more entries) must state each one's share:
 * defaulting a second or third entry to "the whole line" would double-count it,
 * so the service refuses an omitted amount once there is more than one entry
 * (`ValidationError`, not a precondition — the shape of the request, not the
 * state of anything).
 */
const entryAmountSchema = minorUnitsSchema.nullish().meta({
  description:
    'How much of the line this entry accounts for, as a positive magnitude. Defaults to the whole ' +
    'of the line when this is the only entry in the request; required once there is more than one.',
});

/**
 * Codes (part of) the line to an account and posts the journal.
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
  amount: entryAmountSchema,
  contactId: z.uuid().nullish(),
  dimensionValueIds: dimensionValueIdsSchema.optional(),
  memo: clearingMemoSchema.nullish(),
});

/**
 * Links (part of) the line to a journal that already exists.
 *
 * This is the shape that makes the statement corroborating evidence rather than a
 * second book: most of what a well-kept ledger sees on a statement is already in
 * it, and clearing says "this is that", not "post it again". A journal already
 * linked to another entry is `journal_already_cleared` — one movement of money, one
 * entry, one statement line it belongs to.
 *
 * `link_entry` carries no `amount`: what it accounts for is the linked journal's
 * own net movement on the bank account (`journalBankMovement`), a fact rather than
 * a choice, so there is nothing here for a caller to state.
 */
const linkEntryClearingSchema = z.strictObject({
  method: z.literal('link_entry'),
  journalId: z.uuid().meta({
    description:
      'The posted journal this entry is evidence for. Its net movement on the bank account is what ' +
      'it accounts for.',
  }),
  memo: clearingMemoSchema.nullish(),
});

/**
 * Records a payment for (part of) the line and applies it to an open invoice or
 * bill.
 *
 * `amount` is a **positive magnitude**, following the M3 allocation rule that an
 * allocation is always positive and the direction carries the sign — the line's own
 * sign decides whether this is money received or paid. That is a change of frame
 * from the response below, where an entry's `amount` is signed so that E4's
 * equation has no conditional in it, and it is worth the change: an allocation that
 * could be negative would be an un-application in disguise, and M3 refused that
 * already.
 */
const allocateDocumentClearingSchema = z.strictObject({
  method: z.literal('allocate_document'),
  targetType: allocationTargetTypeSchema.meta({
    description:
      'The two documents that carry an amount owed, from M3’s allocation vocabulary — an inbound ' +
      'line settles an `invoice`, an outbound one a `bill`.',
  }),
  targetId: z.uuid(),
  amount: entryAmountSchema,
  memo: clearingMemoSchema.nullish(),
});

/**
 * An early-pay discount (D-79, D-106): settles (part of) a document without cash.
 *
 * `amount` is **never defaulted** — unlike the other three, a discount is never
 * "the whole of the line", so a caller always states it. It posts a journal
 * (debit the discount-given account and credit the receivables control for an
 * invoice; the mirror on AP) and applies that amount to `targetId` as a
 * discount-kind allocation (`AllocationSource.kind = 'discount'`,
 * `modules/payments/allocate.ts`), so the document’s `outstanding` falls by the
 * full amount even though the line never carried it.
 *
 * Never suggested by this schema and never auto-posted (D-43): the amount here is
 * whatever the operator confirmed, whether typed by hand or accepted from a later
 * leaf's suggestion (OB-138).
 */
const discountClearingSchema = z.strictObject({
  method: z.literal('discount'),
  accountId: z.uuid().meta({
    description:
      'The discount-given (AR) or discount-received (AP) account this posts to — the org’s ' +
      'nomination, or one chosen for this entry.',
  }),
  targetType: allocationTargetTypeSchema.meta({
    description:
      'The document the discount is against — an invoice or a bill, as `allocate_document`.',
  }),
  targetId: z.uuid(),
  amount: minorUnitsSchema.meta({
    description:
      'The discount amount, as a positive magnitude. Never defaulted: a discount is never the ' +
      'whole of the line.',
  }),
  memo: clearingMemoSchema.nullish(),
});

const clearingEntrySchema = z.discriminatedUnion('method', [
  postEntryClearingSchema,
  linkEntryClearingSchema,
  allocateDocumentClearingSchema,
  discountClearingSchema,
]);

export type ClearingEntry = z.infer<typeof clearingEntrySchema>;

/**
 * Accepting: the one request in this module that writes to the ledger.
 *
 * Note what is absent. There is no `proposalId` the server must honour, no
 * `acceptAll`, and no batch that would let a client sweep a *statement* in one
 * call — `entries` is an array within *one line's* clear, never across lines. The
 * omission is the temptation D-43 exists to refuse: a bulk accept is an
 * auto-poster with a human's name on it, and "an auto-poster's mistakes land in an
 * append-only ledger where the correction is a reversing entry."
 */
export const clearBankStatementLineRequestSchema = z
  .strictObject({
    entries: z
      .array(clearingEntrySchema)
      .min(1)
      .meta({
        description:
          'What clears the line, one entry per target. A single-target clear — OB-081’s original ' +
          'shape — is `entries` with exactly one element.',
      }),
    differenceAccountId: differenceAccountIdSchema,
  })
  .meta({
    id: 'ClearBankStatementLineRequest',
    description:
      'Accepting: the one request that writes to the ledger. `entries` names one or more of ' +
      '`post_entry`, `link_entry`, `allocate_document`, and `discount` (D-80); together they ' +
      'account for the line, up to the recorded `differenceAccountId` residual. No `proposalId`, ' +
      'no `acceptAll`, no cross-line batch (D-43).',
  });

export type ClearBankStatementLineRequest = z.infer<typeof clearBankStatementLineRequestSchema>;

/**
 * One entry of an accepted clear, as the API returns it.
 *
 * `amount` is **signed, in the line's frame**, for every `entryType` including
 * `discount` — a consistent read across the array — even though a `discount`
 * entry's amount is excluded from the E4 sum the parent's `clearedAmount` records
 * (see `clearing.ts`'s file header). `accountId`/`targetType`/`targetId` are
 * nullable *together* by pair, following `bankLineClearingSchema`'s own precedent
 * for fields absent as a group: `accountId` is set on `post_entry`/`discount`,
 * `targetType`+`targetId` on `allocate_document`/`discount`, and `paymentId` only
 * on `allocate_document` (`chk_blce_payment_only_allocate`, `0006_banking`).
 */
export const bankLineClearingEntrySchema = z
  .strictObject({
    id: z.uuid(),
    entryType: bankClearingEntryTypeSchema,
    clearedJournalId: z.uuid().meta({
      description:
        'The journal that accounts for this entry — created by `post_entry`/`discount`, named by ' +
        '`link_entry`, or the payment’s own under `allocate_document`.',
    }),
    paymentId: z.uuid().nullable().meta({
      description: 'The payment this entry recorded. Non-null only on `allocate_document`.',
    }),
    accountId: z.uuid().nullable(),
    targetType: allocationTargetTypeSchema.nullable(),
    targetId: z.uuid().nullable(),
    amount: bankLineAmountSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'BankLineClearingEntry',
    description:
      'One entry of a clear. Signed in the line’s frame; `discount` entries are excluded from the ' +
      'sum the parent’s `clearedAmount` records (D-106).',
  });

export type BankLineClearingEntry = z.infer<typeof bankLineClearingEntrySchema>;

/**
 * One clearing, as the API returns it — the parent D-105 keeps one-per-line, plus
 * the entries that made it up.
 *
 * `clearedAmount` and `differenceAmount` are **signed, in the line's frame**, so
 * that E4 is checkable without consulting anything else:
 * `clearedAmount + differenceAmount` equals the line's `amount`, exactly, on every
 * clearing this system will produce — `clearedAmount` being the sum of `entries`'
 * own amounts, excluding any `discount`.
 *
 * `differenceAccountId` and `differenceJournalId` are non-null exactly when
 * `differenceAmount` is non-zero. Nullable together rather than a nested nullable
 * object, following `agingDocumentSchema`'s precedent for fields that are absent as
 * a group.
 */
export const bankLineClearingSchema = z
  .strictObject({
    id: z.uuid(),
    lineId: z.uuid(),
    entries: z.array(bankLineClearingEntrySchema).min(1),
    clearedAmount: bankLineAmountSchema.meta({
      description:
        'What the entries account for, signed in the line’s frame — the sum of `entries`’ own ' +
        'amounts, excluding any `discount` (D-106). Equal to the line’s `amount` unless a ' +
        'difference was recorded.',
    }),
    differenceAmount: bankLineAmountSchema.meta({
      description:
        '`line.amount − clearedAmount`, exactly. Zero on almost every clearing; non-zero is a bank ' +
        'charge or a short payment, and it has been posted, not absorbed (E4).',
    }),
    differenceAccountId: z.uuid().nullable(),
    differenceJournalId: z.uuid().nullable(),
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
  })
  .meta({
    id: 'BankLineClearing',
    description:
      'One clearing, as the API returns it — one or more entries, signed in the line’s frame, ' +
      'summing (the non-`discount` ones) plus `differenceAmount` to the line’s `amount` (E4).',
  });

export type BankLineClearing = z.infer<typeof bankLineClearingSchema>;

/**
 * Undoing a clearing.
 *
 * The link is removed — parent and every entry, as a unit — and, where an entry
 * posted a journal, that journal is reversed — never deleted (D-16, spec §2.2).
 * `date` is the reversal's own entry date and must itself fall in an open period,
 * which is `voidDocumentRequestSchema`'s argument and applies here for the same
 * reason: by the time somebody notices a mis-accepted proposal, the line's own
 * month is often closed.
 *
 * A `link_entry` entry posts nothing to reverse unless the whole clear recorded a
 * difference, so `date` is unused in that case rather than forbidden — a shape
 * that varied by which entries are being undone would make a client look up their
 * kinds before it could undo any of them.
 *
 * Undoing a clearing counted by a finalised session is
 * `reconciliation_session_already_finalised`. The session is what makes the
 * assertion, and an assertion whose evidence can be withdrawn afterwards asserts
 * nothing (E6 — reopening is permission-gated and recorded, and it is the way in).
 */
export const removeBankLineClearingRequestSchema = z
  .strictObject({
    date: calendarDateSchema.meta({
      description: 'The reversal’s own entry date, which must fall in an open fiscal period.',
    }),
    memo: clearingMemoSchema.nullish(),
  })
  .meta({
    id: 'RemoveBankLineClearingRequest',
    description:
      'Undoes a clearing — every entry, as a unit. Where an entry posted a journal, that journal is ' +
      'reversed — never deleted (D-16) — so `date` is the reversal’s own entry date and must fall ' +
      'in an open period.',
  });

export type RemoveBankLineClearingRequest = z.infer<typeof removeBankLineClearingRequestSchema>;
