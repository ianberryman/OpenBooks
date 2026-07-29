import type { JournalLineInput } from '@openbooks/plugin-api';
import type { AllocationInput } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, uuidToBuffer } from '../../db';
import { postJournal } from '../ledger';
import { resolveControlAccount } from '../settings';
import type { SubledgerSide } from '../settings';

import { applyAllocations } from './allocate';

/**
 * A settlement-discount posting, extracted so bank clearing's `discount` entry
 * (D-106) and Pay Bills' issue-time early-pay discount (D-112) cannot drift into
 * two implementations of the same journal shape.
 *
 * Before this, the posting lived inline in `modules/banking/clearing`, reachable
 * only from a bank match. Pay Bills settles a discount at the moment a payment is
 * issued — before any bank line exists to clear against — so it needed the same
 * mechanism from a different caller rather than a second copy of it (ROADMAP
 * D-112). Everything this function does, `modules/banking/clearing` used to do
 * itself; nothing about the journal, the accounts it names, or the allocation it
 * applies has changed by moving it here.
 */

/** What a settlement discount is being posted for, and where it goes. */
export interface PostSettlementDiscountInput {
  readonly side: SubledgerSide;
  readonly targetType: 'invoice' | 'bill';
  /** The document uuid the discount settles. */
  readonly targetId: string;
  /** The account credited (AP) or debited (AR) — the mirror of the control account. */
  readonly discountAccountId: string;
  /** A positive magnitude, minor units — the caller's to have already resolved. */
  readonly amount: bigint;
  /** The document's own contact — an allocation may never cross contacts. */
  readonly contactId: string;
  readonly date: string;
  readonly memo: string | null;
  /**
   * `'clearing'` for a bank-match discount, `'payment'` for Pay Bills issuing one
   * directly — the only difference between the two callers, and the reason
   * `source` is a parameter here rather than hard-coded the way the single-caller
   * version had it.
   */
  readonly source: 'clearing' | 'payment';
}

/**
 * Posts one balanced journal for a settlement discount — AR: debit the discount
 * account, credit the receivables control; AP: debit the payables control, credit
 * the discount account — then applies it as a `'discount'`-kind allocation (D-106)
 * so the target's `outstanding` nets down through the one mechanism every
 * settlement uses (D-39), rather than a bespoke adjustment.
 *
 * The control account is resolved here, not by the caller: both callers would
 * otherwise have to know which side's setting to read, and getting that wrong is
 * invisible until a balance sheet is (see `resolveControlAccount`'s own
 * commentary). Returns the discount journal's id, which the caller stores as its
 * entry's `clearedJournalId` / equivalent, so undo can reverse it and delete the
 * allocation it made.
 */
export async function postSettlementDiscount(
  trx: TenantDatabase,
  input: PostSettlementDiscountInput,
  ctx: RequestContext,
  author: Buffer,
): Promise<Buffer> {
  const controlAccountId = await resolveControlAccount(trx, input.side);

  const posted = await postJournal(
    {
      date: input.date,
      ...(input.memo === null ? {} : { memo: input.memo }),
      source: input.source,
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
      lines: discountLines(
        input.side,
        input.discountAccountId,
        bufferToUuid(controlAccountId),
        input.amount,
        input.contactId,
      ),
    },
    ctx,
  );
  const discountJournalId = uuidToBuffer(posted.journalId);

  const allocationInputs: readonly AllocationInput[] = [
    { targetType: input.targetType, targetId: input.targetId, amount: input.amount.toString() },
  ];

  await applyAllocations(
    trx,
    {
      side: input.side,
      kind: 'discount',
      id: discountJournalId,
      contactId: uuidToBuffer(input.contactId),
      available: input.amount,
      label: 'discount',
    },
    allocationInputs,
    input.date,
    author,
  );

  return discountJournalId;
}

/**
 * The discount journal's two lines (D-106): debit the discount account and credit
 * the receivables control for an invoice; debit the payables control and credit
 * the discount account for a bill — the mirror, and exactly the shape a payment's
 * `journalLines` builds, with the discount account standing in for the bank
 * account. Neither line names a bank ledger account: a discount moves no cash, so
 * it never appears here — true whether the caller is a bank match or Pay Bills
 * issuing one directly.
 */
function discountLines(
  side: SubledgerSide,
  discountAccountId: string,
  controlAccountId: string,
  amount: bigint,
  contactId: string,
): readonly JournalLineInput[] {
  const discount = { accountId: discountAccountId, amount, contactId } as const;
  const control = { accountId: controlAccountId, amount, contactId } as const;

  return side === 'receivable'
    ? [
        { ...discount, side: 'debit' as const },
        { ...control, side: 'credit' as const },
      ]
    : [
        { ...control, side: 'debit' as const },
        { ...discount, side: 'credit' as const },
      ];
}
