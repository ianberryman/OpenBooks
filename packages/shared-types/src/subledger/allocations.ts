import { z } from 'zod';

import { calendarDateSchema, minorUnitsSchema } from '../wire';

/**
 * Allocation: the fact that records what settled what (OB-061, for OB-064;
 * ROADMAP D-37, D-39).
 *
 * ## Why this is one mechanism and not three
 *
 * A payment settles an invoice. A credit note also settles an invoice. A vendor
 * credit settles a bill. D-39 makes the middle one explicit — a credit note
 * "allocates against invoices through the same mechanism payments use, so *what is
 * outstanding* has one definition regardless of what reduced it" — and this file is
 * that mechanism. Three separate link tables would give the aging report three
 * things to sum and C2 three places to disagree with the ledger.
 *
 * ## An allocation moves no money and posts no journal
 *
 * This is the property that makes D-34 and C2 hold, and it is worth stating because
 * it is counter-intuitive. Receiving a payment posts a journal: the bank account is
 * debited and the receivables control account credited, at the moment the money
 * arrives. Approving a credit note posts its own journal. By the time an allocation
 * is recorded, both sides are already in the ledger and the control account already
 * carries the right balance — the allocation only says *which* invoice the credit
 * belongs against. A second journal here would double-count, which is precisely how
 * the subledger would come to disagree with the ledger.
 *
 * The consequence is that an allocation is an ordinary mutable row, not a ledger
 * entry: it can be removed, and removing it changes no report of the ledger. What
 * it changes is what is outstanding — which is computed, so it needs no correction
 * anywhere else (D-34).
 */

/**
 * What can be applied. Each of these is a document that has already put money — or
 * an obligation — into the ledger.
 */
export const ALLOCATION_SOURCE_TYPES = ['payment', 'credit_note', 'vendor_credit'] as const;

export type AllocationSourceType = (typeof ALLOCATION_SOURCE_TYPES)[number];

/** What can be settled. Only the two documents that carry an amount owed. */
export const ALLOCATION_TARGET_TYPES = ['invoice', 'bill'] as const;

export type AllocationTargetType = (typeof ALLOCATION_TARGET_TYPES)[number];

export const allocationSourceTypeSchema = z.enum(ALLOCATION_SOURCE_TYPES);

export const allocationTargetTypeSchema = z.enum(ALLOCATION_TARGET_TYPES);

/**
 * The date the allocation takes effect, which is **not** a formality.
 *
 * D-40 requires aging to be computed *as at* a historical date and says why:
 * "using today's allocations against a past date's documents would produce a report
 * that cannot be reproduced tomorrow". An allocation therefore carries its own
 * date, an aging report ignores the allocations dated after its `asOf`, and last
 * month's aging still prints last month's figures next year.
 *
 * It defaults to the source's own date rather than to today, so recording a payment
 * that arrived last week and applying it in the same call does not date the
 * settlement to the day someone got round to the paperwork.
 */
const allocationDateSchema = calendarDateSchema.meta({
  description:
    'When this allocation takes effect. Aging as at a date counts only the allocations dated on ' +
    'or before it (D-40), so this is what makes a historical aging report reproducible. ' +
    'Defaults to the date of the payment or credit note being applied.',
});

/**
 * The amount, which is always positive.
 *
 * A negative allocation would be an un-application wearing a disguise, and it would
 * make "the sum of allocations" a number that can move in both directions without
 * anything being removed. Removing an allocation is its own operation and needs no
 * body, so it appears in no schema here (OB-067 gives it a path).
 */
const allocationAmountSchema = minorUnitsSchema.meta({
  description:
    'How much of the source is applied to this target, in minor units. Always positive. ' +
    'Allocations against one document may not exceed it (C3) — over-allocating is refused, ' +
    'while over-*paying* is fine and lands as a credit on the contact (D-37).',
});

/**
 * One application, as a client sends it: which document, and how much.
 *
 * The source is not named here because it is the thing being applied — a client
 * allocates *from* a payment or a credit note, so the source is the resource in the
 * path and naming it in the body would make the two disagreeable.
 */
export const allocationInputSchema = z
  .strictObject({
    targetType: allocationTargetTypeSchema,
    targetId: z.uuid(),
    amount: allocationAmountSchema,
  })
  .meta({
    // Not `AllocationInput`: the transform emits an `XInput` component beside every
    // `X`, so that name is already `Allocation`'s. `…Request` is the register.
    id: 'AllocationRequest',
    description:
      'One application, as a client sends it: which document, and how much. The source is not ' +
      'named here because it is the resource in the path.',
  });

export type AllocationInput = z.infer<typeof allocationInputSchema>;

/**
 * Applies one source to several targets in one call.
 *
 * A batch rather than a call per target, because "this transfer paid three
 * invoices" (D-37) is one decision by one person and has to succeed or fail as one:
 * applying two of the three and refusing the fourth for over-allocation would leave
 * the user to work out which half happened.
 */
export const createAllocationsRequestSchema = z
  .strictObject({
    date: allocationDateSchema.optional(),
    allocations: z.array(allocationInputSchema).min(1),
  })
  .meta({
    id: 'CreateAllocationsRequest',
    description:
      'Applies one source to several targets in one call. A batch rather than a call per target, ' +
      'because “this transfer paid three invoices” is one decision and has to succeed or fail as ' +
      'one — applying two and refusing the third would leave the user to work out which half ' +
      'happened.',
  });

export type CreateAllocationsRequest = z.infer<typeof createAllocationsRequestSchema>;

/**
 * One allocation as the API returns it, naming both ends.
 *
 * Both ends rather than only the far one, because the same schema is embedded on a
 * payment (where the client knows the source) and on an invoice (where it knows the
 * target), and a shape that dropped the known end would be two shapes.
 */
export const allocationSchema = z
  .strictObject({
    id: z.uuid(),
    sourceType: allocationSourceTypeSchema,
    sourceId: z.uuid(),
    sourceNumber: z
      .string()
      .nullable()
      .meta({
        description:
          'The source document’s own number, or null for a payment — a payment is money moving, not ' +
          'a numbered document (D-36 numbers the four document types and nothing else).',
      }),
    targetType: allocationTargetTypeSchema,
    targetId: z.uuid(),
    targetNumber: z.string().nullable(),
    amount: allocationAmountSchema,
    date: allocationDateSchema,
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'Allocation',
    description:
      'One allocation as the API returns it, naming both ends — the same shape is embedded on a ' +
      'payment, where the client knows the source, and on an invoice, where it knows the target.',
  });

export type Allocation = z.infer<typeof allocationSchema>;

/**
 * The response envelope for a batch of allocations (OB-067).
 *
 * An envelope rather than a bare array, for `orgMemberListSchema`'s reason: a
 * top-level object has somewhere to put a later addition, and a top-level JSON array
 * has nowhere at all. Unpaginated deliberately — the array is exactly the
 * `allocations` the request named, bounded by the request itself rather than by the
 * org's data, so there is nothing here for a cursor to page.
 *
 * Not `pageSchema`: this is not a list of what exists, it is the result of one
 * write, and giving it a `nextCursor` that is always `null` would invite a client to
 * page it.
 */
export const allocationListSchema = z
  .strictObject({
    allocations: z.array(allocationSchema),
  })
  .meta({
    id: 'AllocationList',
    description: 'The allocations this call wrote, in the order they were applied.',
  });

export type AllocationList = z.infer<typeof allocationListSchema>;
