import type { JournalLineInput, PostJournalInput } from '@openbooks/plugin-api';
import type {
  BankClearingEntryType,
  BankLineClearing,
  ClearBankStatementLineRequest,
  ClearingEntry,
  RemoveBankLineClearingRequest,
} from '@openbooks/shared-types';
import {
  BANKING_PRECONDITIONS,
  clearBankStatementLineRequestSchema,
  removeBankLineClearingRequestSchema,
} from '@openbooks/shared-types';

import { getContext } from '../../../context';
import type { RequestContext } from '../../../context';
import {
  bufferToUuid,
  isDuplicateEntryError,
  newUuidBuffer,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../../db';
import type { TenantDatabase } from '../../../db';
import {
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
  parseInput,
} from '../../../errors';
import { postJournal, reverseJournal } from '../../ledger';
import {
  applyAllocations,
  deleteAllocationsForDiscountJournal,
  recordPayment,
  voidPayment,
} from '../../payments';
import { requirePermission } from '../../permissions';
import { resolveControlAccount } from '../../settings';
import type { SubledgerSide } from '../../settings';

import type { ClearingEntryRow, ClearingRow, StatementLineRow } from './clearing.repository';
import {
  BANK_ACCOUNT_RESOURCE,
  DOCUMENT_RESOURCE,
  JOURNAL_RESOURCE,
  STATEMENT_LINE_RESOURCE,
  deleteClearing,
  deleteEntriesForClearing,
  insertClearing,
  insertClearingEntries,
  journalBankMovement,
  journalExists,
  orgScope,
  selectBankAccount,
  selectClearingByLine,
  selectClearingIdByJournal,
  selectDocumentContactId,
  selectEntriesForClearing,
  selectStatementLine,
} from './clearing.repository';

/**
 * Accepting a match: one line, one or more entries (OB-081, generalised by OB-137;
 * ROADMAP D-43, D-16, D-80, D-105, D-106; acceptance E3, E4).
 *
 * This is where the banking pipeline first writes to the ledger, and it writes
 * because a human asked it to (D-43, E3). Nothing in `matching/` reaches this file;
 * a request carries what it wants done — one or more entries, each an account to
 * code to, a journal to link, a document to settle or discount — whether a
 * proposal suggested the first of them or a person typed every one. There is no
 * `proposalId` it honours and no batch across *lines*, which is the shape D-43
 * exists to refuse; a batch *within* one line's clear is D-80's, not D-43's.
 *
 * ## Every ledger write goes through the sanctioned service, never around it
 *
 * `post_entry`, `discount`, and the difference journal post through `postJournal`;
 * `allocate_document` records through `recordPayment` (which posts through
 * `postJournal` and allocates through M3's one mechanism, D-39); `discount` posts
 * its own journal directly and applies it through the same `applyAllocations`
 * `recordPayment` uses, with a `'discount'` source kind (D-106) rather than a
 * `payments` row a discount never had; undo reverses through `reverseJournal` and
 * `voidPayment`. Balance validation, the period lock (A4/A9) and actor provenance
 * all live in those services, and this file re-implements none of them —
 * `openbooks/no-journal-writes` is what makes that structural rather than a habit.
 *
 * ## E4 is an equation, held in the line's own frame — generalised for N entries
 *
 * A statement line carries a **signed** amount (`bank_statement_lines.amount_minor`),
 * and every clearing this file produces satisfies
 *
 *   Σ(entry.amount, excluding `discount`) + differenceAmount === line.amount
 *
 * signed, exactly, with no conditional (`assertClearingBalances`). `discount` is
 * excluded from the sum deliberately: D-106 funds it from the discount journal, not
 * from the line's own cash, so counting it toward what the *line* must add up to
 * would be counting money the bank never saw — it settles the *document* instead,
 * through its own allocation. A £990 line clearing a £1,000 entry records +£1,000
 * cleared and −£10 to bank charges, and the bank ledger moves by exactly the £990
 * the statement shows. A non-zero difference with no account is
 * `clearing_difference_unaccounted`.
 *
 * ## Why there is no `FOR UPDATE` on the line or a journal
 *
 * Both are append-only at the grant level, and MySQL will not grant a locking read to
 * an identity without `UPDATE`/`DELETE` on the table (D-14). Two clearings racing the
 * same line or the same entry are serialized instead by `uq_blc_line` (the parent
 * insert) and `uq_blce_journal` (the child insert), and the loser is translated to
 * `statement_line_already_cleared` / `journal_already_cleared` — the shape
 * `reverseJournal` uses for `uq_journals_org_reverses`, proven under two connections
 * in `clearing.race.test.ts`.
 *
 * ## The known role gap (OB-093), not papered over
 *
 * The service gates on `banking.match`. Beyond that, `post_entry`/`discount` and any
 * difference reach `journals.post`; `allocate_document` reaches
 * `payments_received.write` / `payments_made.write` (by the line's sign) *and*
 * `journals.post`; undo reaches `journals.reverse`, and undo of an
 * `allocate_document` entry reaches the payment write plus `journals.reverse`. So a
 * role holding `banking.match` but not the ledger codes can accept a plain
 * `link_entry` (which posts nothing) and is refused the rest — the same gap OB-093
 * records for the AR/AP clerks, surfaced here rather than hidden.
 */

interface ClearingEntryComputation {
  readonly entryType: BankClearingEntryType;
  readonly clearedJournalId: Buffer;
  readonly paymentId: Buffer | null;
  readonly accountId: Buffer | null;
  readonly targetType: 'invoice' | 'bill' | null;
  readonly targetId: Buffer | null;
  /** Signed, in the line's frame — see the file header on why `discount` is excluded from Σ. */
  readonly amount: bigint;
}

/**
 * Accepts a statement line against one or more entries, and writes one parent
 * `bank_line_clearings` row plus one `bank_line_clearing_entries` row per entry.
 *
 * The order of operations: permission first (before the payload is examined), then
 * the line and its bank account, then each entry's own work in turn — which is the
 * only part that touches the ledger — then the E4 invariant, then the two inserts.
 * Everything after the permission is one transaction, so every journal an entry
 * posted and the rows that name them commit together: if the line turns out
 * already cleared, or a later entry's journal is already claimed, everything already
 * done rolls back with it rather than being orphaned.
 */
export async function clearBankStatementLine(
  lineId: string,
  input: ClearBankStatementLineRequest,
  ctx: RequestContext = getContext('clearBankStatementLine()'),
): Promise<BankLineClearing> {
  await requirePermission(ctx, 'banking.match');

  const request = parseInput(clearBankStatementLineRequestSchema, input);
  const author = requireClearingUser(ctx);
  const lineBytes = assertFound(tryUuidToBuffer(lineId), STATEMENT_LINE_RESOURCE);

  return orgScope(ctx).transaction(async (trx) => {
    const line = assertFound(await selectStatementLine(trx, lineBytes), STATEMENT_LINE_RESOURCE);
    const bankLedgerAccountId = await resolveBankLedgerAccount(trx, line.bank_account_id);

    // A better message than the unique key alone. It races, and `uq_blc_line` does
    // not — the catch on the insert below is what actually closes the window.
    const existing = await selectClearingByLine(trx, lineBytes);
    if (existing !== undefined) throw statementLineAlreadyCleared();

    const computations: ClearingEntryComputation[] = [];
    const isSole = request.entries.length === 1;
    for (const [index, entry] of request.entries.entries()) {
      computations.push(
        await computeEntry(trx, ctx, author, entry, index, isSole, line, bankLedgerAccountId),
      );
    }

    // D-106: a `discount` entry is funded by its own journal, not by the line's
    // cash, so it is excluded from what the line has to add up to.
    const bankMovementTotal = computations
      .filter((computation) => computation.entryType !== 'discount')
      .reduce((total, computation) => total + computation.amount, 0n);
    const differenceAmount = line.amount_minor - bankMovementTotal;

    const difference = await resolveDifference(
      ctx,
      line.posted_date,
      bufferToUuid(bankLedgerAccountId),
      differenceAmount,
      request.differenceAccountId,
    );

    // E4 as an invariant, not a check: the amounts are already constructed so this
    // holds, and it is here to refuse any future path that computed them independently.
    assertClearingBalances(bankMovementTotal, differenceAmount, line.amount_minor);

    const clearingId = newUuidBuffer();
    try {
      await insertClearing(trx, {
        id: clearingId,
        statementLineId: lineBytes,
        clearedAmountMinor: bankMovementTotal,
        differenceAmountMinor: differenceAmount,
        differenceAccountId: difference.accountId,
        differenceJournalId: difference.journalId,
        createdByUserId: author,
      });
      await insertClearingEntries(
        trx,
        computations.map((computation) => ({
          id: newUuidBuffer(),
          clearingId,
          entryType: computation.entryType,
          clearedJournalId: computation.clearedJournalId,
          paymentId: computation.paymentId,
          accountId: computation.accountId,
          targetType: computation.targetType,
          targetId: computation.targetId,
          entryAmountMinor: computation.amount,
        })),
      );
    } catch (error: unknown) {
      // The losing side of a race the pre-checks could not see: `uq_blc_line` (this
      // line, by another clearing committed after our snapshot) or `uq_blce_journal`
      // (one of these entries' journals, by a second clearing). Re-derive which, so
      // the answer is the precondition the client can branch on rather than an
      // opaque `internal_error`.
      if (isDuplicateEntryError(error)) {
        throw await translateClearingDuplicate(trx, error, lineBytes, computations);
      }
      throw error;
    }

    return assembleClearing(
      assertFoundAfterWrite(await selectClearingByLine(trx, lineBytes)),
      await selectEntriesForClearing(trx, clearingId),
    );
  });
}

/**
 * Undoing a clearing: remove every entry and the parent, and reverse whatever each
 * entry posted.
 *
 * Never a deletion of a journal (D-16). A `post_entry`/`discount` entry reverses
 * its own journal; an `allocate_document` entry voids its payment (reversing that
 * journal and deleting its allocations, M3's own undo); a `discount` entry also
 * deletes the allocation its journal made (`deleteAllocationsForDiscountJournal`,
 * the mirror of what voiding a payment does for the fourth); a `link_entry` entry
 * reverses only a difference it may have contributed to, and never the entry it
 * linked — that entry existed before the clearing and outlives it. The reversal's
 * date must fall in an open period (`removeBankLineClearingRequest`), which is why
 * undo carries one even when every entry is a `link_entry` that reverses nothing.
 *
 * A clearing a finalised session counted is refused: the session asserted a balance
 * at a date, and an assertion whose evidence can be withdrawn afterwards asserts
 * nothing (E6). Reopening is OB-082's, and it is the way in.
 */
export async function removeBankLineClearing(
  lineId: string,
  input: RemoveBankLineClearingRequest,
  ctx: RequestContext = getContext('removeBankLineClearing()'),
): Promise<void> {
  await requirePermission(ctx, 'banking.match');

  const request = parseInput(removeBankLineClearingRequestSchema, input);
  const lineBytes = assertFound(tryUuidToBuffer(lineId), STATEMENT_LINE_RESOURCE);

  await orgScope(ctx).transaction(async (trx) => {
    // Guards the 404: an unknown or cross-org line is not-found, not "not cleared"
    // (E9). The result is otherwise unused now that the finalised-session refusal
    // reads the clearing's own stamp rather than the line's date.
    assertFound(await selectStatementLine(trx, lineBytes), STATEMENT_LINE_RESOURCE);

    const clearing = await selectClearingByLine(trx, lineBytes);
    if (clearing === undefined) {
      throw new PreconditionFailedError(
        BANKING_PRECONDITIONS.STATEMENT_LINE_NOT_CLEARED,
        'This statement line has no clearing to remove. There is nothing to un-match.',
      );
    }

    // D-51: a finalised session freezes its membership by stamping its id onto the
    // clearings it counted, so "counted by a finalised session" is exactly this
    // stamp — not the line's date. A straggler cleared into an already-finalised
    // window is left unstamped and was never part of the assertion, so it may be
    // undone; a stamped clearing may not, because doing so would silently falsify the
    // balance that session asserted (E6). The stamp is cleared on reopen, which is
    // the permission-gated, recorded way back in.
    if (clearing.reconciliation_session_id !== null) {
      throw new PreconditionFailedError(
        BANKING_PRECONDITIONS.RECONCILIATION_SESSION_ALREADY_FINALISED,
        'A finalised reconciliation session counts this line, so its clearing cannot be undone: ' +
          'doing so would silently falsify the balance that session asserted (E6). Reopen the ' +
          'session first — reopening is permission-gated and recorded, and it is the way in.',
      );
    }

    const entries = await selectEntriesForClearing(trx, clearing.id);

    for (const entry of entries) {
      if (entry.entry_type === 'allocate_document' && entry.payment_id !== null) {
        // Voids the payment: reverses its journal (which is `cleared_journal_id`)
        // and deletes the allocations it made, so what it settled is outstanding
        // again.
        await voidPayment(
          bufferToUuid(entry.payment_id),
          {
            date: request.date,
            ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
          },
          ctx,
        );
      } else if (entry.entry_type === 'post_entry') {
        await reverseClearingJournal(ctx, entry.cleared_journal_id, request);
      } else if (entry.entry_type === 'discount') {
        // The mirror of voiding a payment, for the third allocation source: reverse
        // the discount's own journal, then remove the allocation it made — without
        // the second step the document's `outstanding` would stay understated by
        // the discount, even though the journal that funded it was just reversed.
        await reverseClearingJournal(ctx, entry.cleared_journal_id, request);
        await deleteAllocationsForDiscountJournal(trx, entry.cleared_journal_id);
      }
      // A `link_entry` entry never reverses `cleared_journal_id`: it did not post it.
    }

    if (clearing.difference_journal_id !== null) {
      await reverseClearingJournal(ctx, clearing.difference_journal_id, request);
    }

    await deleteEntriesForClearing(trx, clearing.id);
    await deleteClearing(trx, clearing.id);
  });
}

// ---------------------------------------------------------------------------
// The four entry kinds
// ---------------------------------------------------------------------------

async function computeEntry(
  trx: TenantDatabase,
  ctx: RequestContext,
  author: Buffer,
  entry: ClearingEntry,
  index: number,
  isSole: boolean,
  line: StatementLineRow,
  bankLedgerAccountId: Buffer,
): Promise<ClearingEntryComputation> {
  const bankLedgerUuid = bufferToUuid(bankLedgerAccountId);

  switch (entry.method) {
    case 'post_entry': {
      const magnitude = resolveEntryAmount(entry.amount, line.amount_minor, isSole, index);
      const signedAmount = signLikeLine(magnitude, line.amount_minor);

      const posted = await postJournal(
        postInput(ctx, line.posted_date, entry.memo, [
          bankMovementLine(bankLedgerUuid, signedAmount),
          codedLine(entry.accountId, signedAmount, entry.contactId, entry.dimensionValueIds),
        ]),
        ctx,
      );
      return {
        entryType: 'post_entry',
        clearedJournalId: uuidToBuffer(posted.journalId),
        paymentId: null,
        accountId: uuidToBuffer(entry.accountId),
        targetType: null,
        targetId: null,
        amount: signedAmount,
      };
    }

    case 'link_entry': {
      const journalId = assertFound(tryUuidToBuffer(entry.journalId), JOURNAL_RESOURCE);
      if (!(await journalExists(trx, journalId))) throw new NotFoundError(JOURNAL_RESOURCE);

      const alreadyCleared = await selectClearingIdByJournal(trx, journalId);
      if (alreadyCleared !== undefined) throw journalAlreadyCleared();

      const amount = await journalBankMovement(trx, journalId, bankLedgerAccountId);
      return {
        entryType: 'link_entry',
        clearedJournalId: journalId,
        paymentId: null,
        accountId: null,
        targetType: null,
        targetId: null,
        amount,
      };
    }

    case 'allocate_document': {
      const side: SubledgerSide = entry.targetType === 'invoice' ? 'receivable' : 'payable';
      const direction = paymentDirectionFor(line.amount_minor);

      const settle = resolveEntryAmount(entry.amount, line.amount_minor, isSole, index);
      const signedAmount = direction === 'received' ? settle : -settle;

      const targetId = assertFound(tryUuidToBuffer(entry.targetId), DOCUMENT_RESOURCE);
      const contactId = assertFound(
        await selectDocumentContactId(trx, side, targetId),
        DOCUMENT_RESOURCE,
      );

      // Records the payment against the bank account and applies it to the document
      // through M3's one mechanism (D-39, C3) — outstanding keeps its single
      // definition, and over-allocation is refused there, not re-decided here.
      const payment = await recordPayment(
        {
          direction,
          contactId: bufferToUuid(contactId),
          date: line.posted_date,
          amount: settle.toString(),
          accountId: bankLedgerUuid,
          ...(entry.memo === undefined || entry.memo === null ? {} : { memo: entry.memo }),
          allocations: [
            {
              targetType: entry.targetType,
              targetId: entry.targetId,
              amount: settle.toString(),
            },
          ],
        },
        ctx,
      );

      return {
        entryType: 'allocate_document',
        clearedJournalId: uuidToBuffer(payment.journalId),
        paymentId: uuidToBuffer(payment.id),
        accountId: null,
        targetType: entry.targetType,
        targetId,
        amount: signedAmount,
      };
    }

    case 'discount': {
      // D-106: a settlement whose funding source is the discount journal, not
      // cash. It never touches the bank ledger account at all — the journal is
      // debit discount-given / credit the receivables control for an invoice, the
      // mirror on AP — so there is no `bankMovementLine` here, unlike every other
      // entry kind.
      const side: SubledgerSide = entry.targetType === 'invoice' ? 'receivable' : 'payable';
      const magnitude = resolveEntryAmount(entry.amount, line.amount_minor, isSole, index);
      const signedAmount = signLikeLine(magnitude, line.amount_minor);

      const targetId = assertFound(tryUuidToBuffer(entry.targetId), DOCUMENT_RESOURCE);
      const contactId = assertFound(
        await selectDocumentContactId(trx, side, targetId),
        DOCUMENT_RESOURCE,
      );
      const contactUuid = bufferToUuid(contactId);
      const controlAccountId = await resolveControlAccount(trx, side);

      const posted = await postJournal(
        postInput(
          ctx,
          line.posted_date,
          entry.memo,
          discountLines(
            side,
            entry.accountId,
            bufferToUuid(controlAccountId),
            magnitude,
            contactUuid,
          ),
        ),
        ctx,
      );
      const discountJournalId = uuidToBuffer(posted.journalId);

      // The same mechanism a payment or a credit note settles through (D-39),
      // applied with the third source kind D-106 adds: `outstanding` reaches zero
      // for the discounted amount without a special case in
      // `documentTotal − allocatedToDocument`.
      await applyAllocations(
        trx,
        {
          side,
          kind: 'discount',
          id: discountJournalId,
          contactId,
          available: magnitude,
          label: 'discount',
        },
        [{ targetType: entry.targetType, targetId: entry.targetId, amount: magnitude.toString() }],
        line.posted_date,
        author,
      );

      return {
        entryType: 'discount',
        clearedJournalId: discountJournalId,
        paymentId: null,
        accountId: uuidToBuffer(entry.accountId),
        targetType: entry.targetType,
        targetId,
        amount: signedAmount,
      };
    }
  }
}

/**
 * Where a non-zero difference goes: a journal that moves the bank account by exactly
 * the difference, with the other side to `differenceAccountId`.
 *
 * The journal is posted *before* the clearing row exists, so a bad difference account
 * — unknown, another org's, deactivated — is refused by `postJournal` (the 404 or
 * `account_inactive`) rather than by a `CHECK` naming nothing. A zero difference posts
 * nothing and stores nothing, which is `chk_blc_difference_accounted`.
 */
async function resolveDifference(
  ctx: RequestContext,
  date: string,
  bankLedgerUuid: string,
  differenceAmount: bigint,
  differenceAccountId: string | null | undefined,
): Promise<{ readonly accountId: Buffer | null; readonly journalId: Buffer | null }> {
  if (differenceAmount === 0n) return { accountId: null, journalId: null };

  if (differenceAccountId === undefined || differenceAccountId === null) {
    throw new PreconditionFailedError(
      BANKING_PRECONDITIONS.CLEARING_DIFFERENCE_UNACCOUNTED,
      `This clearing leaves a difference of ${differenceAmount.toString()} minor units between ` +
        'the line and what its entries account for, and no account was given to post it to. E4 ' +
        'requires the difference to be recorded — a bank charge or a short payment is an entry in ' +
        'the books, not a number absorbed on a screen. Name a `differenceAccountId`, or make the ' +
        'entries add up to the whole of the line.',
    );
  }

  const posted = await postJournal(
    postInput(ctx, date, 'Clearing difference', [
      bankMovementLine(bankLedgerUuid, differenceAmount),
      counterLine(differenceAccountId, differenceAmount),
    ]),
    ctx,
  );

  return {
    accountId: uuidToBuffer(differenceAccountId),
    journalId: uuidToBuffer(posted.journalId),
  };
}

// ---------------------------------------------------------------------------
// E4
// ---------------------------------------------------------------------------

/**
 * E4, at the write: a cleared line and the entries that clear it agree exactly on
 * amount.
 *
 * `bankMovementTotal + differenceAmount === lineAmount`, signed, in the line's
 * frame. Exported so the property suite can assert it in isolation, including the
 * inputs the service cannot produce — a mismatch here is a coding fault, and this
 * is where it is refused rather than silently written. `bankMovementTotal` is the
 * caller's Σ over every entry but `discount` (see the file header); this function
 * takes the pre-summed total rather than the array, exactly as it always has, so a
 * caller decides what belongs in the sum.
 */
export function assertClearingBalances(
  bankMovementTotal: bigint,
  differenceAmount: bigint,
  lineAmount: bigint,
): void {
  const accounted = bankMovementTotal + differenceAmount;
  if (accounted !== lineAmount) {
    throw new PreconditionFailedError(
      BANKING_PRECONDITIONS.CLEARING_AMOUNT_MISMATCH,
      `A clearing must account for the whole of the line. Cleared ${bankMovementTotal.toString()} ` +
        `plus difference ${differenceAmount.toString()} is ${accounted.toString()}, and the line ` +
        `is ${lineAmount.toString()} minor units. The two agree only because the difference is ` +
        'posted (E4).',
    );
  }
}

// ---------------------------------------------------------------------------
// Journal-line construction
// ---------------------------------------------------------------------------

/**
 * A ledger line moving one account by a **signed** amount: debit when positive,
 * credit when negative, magnitude either way. The bank account's line uses this so
 * that "the bank went up by the line's amount" is the same statement as the line's
 * own sign.
 */
function bankMovementLine(bankLedgerUuid: string, signed: bigint): JournalLineInput {
  return {
    accountId: bankLedgerUuid,
    side: signed > 0n ? 'debit' : 'credit',
    amount: magnitude(signed),
  };
}

/** The far side of a difference journal — the opposite side of the bank's movement. */
function counterLine(accountId: string, signedBankMovement: bigint): JournalLineInput {
  return {
    accountId,
    side: signedBankMovement > 0n ? 'credit' : 'debit',
    amount: magnitude(signedBankMovement),
  };
}

/** The coded side of a `post_entry` — the account the line is, carrying its analysis. */
function codedLine(
  accountId: string,
  signedAmount: bigint,
  contactId: string | null | undefined,
  dimensionValueIds: readonly string[] | undefined,
): JournalLineInput {
  return {
    accountId,
    // Opposite the bank: money in (positive) debits the bank and credits the
    // account it came from, and money out is the mirror.
    side: signedAmount > 0n ? 'credit' : 'debit',
    amount: magnitude(signedAmount),
    ...(contactId === undefined || contactId === null ? {} : { contactId }),
    ...(dimensionValueIds === undefined ? {} : { dimensionValueIds: [...dimensionValueIds] }),
  };
}

/**
 * The discount journal's two lines (D-106): debit the discount account and credit
 * the receivables control for an invoice; debit the payables control and credit the
 * discount account for a bill — the mirror, and exactly the shape `recordPayment`'s
 * `journalLines` builds for a payment, with the discount account standing in for
 * the bank account. Neither line names the bank ledger account: a discount moves no
 * cash, so it never appears here.
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

function postInput(
  ctx: RequestContext,
  date: string,
  memo: string | null | undefined,
  lines: readonly JournalLineInput[],
): PostJournalInput {
  return {
    date,
    ...(memo === undefined || memo === null ? {} : { memo }),
    // A statement-line clearing is its own origin (OB-091): the entry and its
    // difference both post as `clearing`, not `manual`.
    source: 'clearing',
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    lines: [...lines],
  };
}

async function reverseClearingJournal(
  ctx: RequestContext,
  journalId: Buffer,
  request: RemoveBankLineClearingRequest,
): Promise<void> {
  await reverseJournal(
    {
      journalId: bufferToUuid(journalId),
      date: request.date,
      ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    },
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Small resolutions
// ---------------------------------------------------------------------------

async function resolveBankLedgerAccount(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<Buffer> {
  const bankAccount = assertFound(
    await selectBankAccount(db, bankAccountId),
    BANK_ACCOUNT_RESOURCE,
  );
  if (bankAccount.is_active !== 1) {
    throw new PreconditionFailedError(
      BANKING_PRECONDITIONS.BANK_ACCOUNT_ARCHIVED,
      'This bank account has been deactivated, so a line cannot be cleared against it. ' +
        'Reactivate it first, or clear the line on the account that is still in use.',
    );
  }
  return bankAccount.account_id;
}

/** `received` for money in, `made` for money out — the line's sign decides (D-13). */
function paymentDirectionFor(lineAmount: bigint): 'received' | 'made' {
  if (lineAmount === 0n) {
    throw new ValidationError('A zero-amount line has no direction to record a payment in.', [
      {
        path: 'entries',
        message:
          'This statement line moved no money, so there is no invoice or bill it can settle. ' +
          'A zero-amount line is coded (`post_entry`) or linked (`link_entry`), not allocated.',
      },
    ]);
  }
  return lineAmount > 0n ? 'received' : 'made';
}

/**
 * How much of the line one entry accounts for, as a positive magnitude — the
 * entry's own `amount` or, when it is the request's only entry, the whole of the
 * line (the ordinary case, where the clear is exactly what the statement shows).
 *
 * Once there is more than one entry, an omitted amount is refused: defaulting a
 * second or third entry to "the whole line" would double-count it, and a genuine
 * split (D-80) has to state each entry's own share. A `ValidationError`, not a
 * precondition — the shape of the request, not the state of anything it names.
 */
function resolveEntryAmount(
  amount: string | null | undefined,
  lineAmount: bigint,
  isSoleEntry: boolean,
  index: number,
): bigint {
  if (amount === undefined || amount === null) {
    if (!isSoleEntry) {
      throw new ValidationError(
        'Each entry needs its own amount once the clear has more than one.',
        [
          {
            path: `entries.${String(index)}.amount`,
            message:
              'This entry omitted `amount`, which only defaults to the whole of the line when it ' +
              'is the request’s only entry. Name how much of the line this entry accounts for.',
          },
        ],
      );
    }
    return magnitude(lineAmount);
  }

  const parsed = BigInt(amount);
  if (parsed <= 0n) {
    throw new ValidationError('An entry’s amount must be a positive magnitude.', [
      {
        path: `entries.${String(index)}.amount`,
        message:
          'This is how much of the line the entry accounts for, always positive; the line’s own ' +
          'sign decides whether the money was received or paid.',
      },
    ]);
  }
  return parsed;
}

/** A magnitude, signed to match the line's own direction — every entry's amount is in this frame. */
function signLikeLine(positiveMagnitude: bigint, lineAmount: bigint): bigint {
  return lineAmount < 0n ? -positiveMagnitude : positiveMagnitude;
}

function magnitude(signed: bigint): bigint {
  return signed < 0n ? -signed : signed;
}

/**
 * The user a clearing is recorded by.
 *
 * `bank_line_clearings.created_by_user_id` is `NOT NULL` and references `users`, so a
 * caller with no user identity — an automation acting outside a member session — has
 * nothing to record as the human D-43 requires. `requireRecordingUser` in payments and
 * `requireImportingUser` in the import service refuse the same way for the same reason.
 */
function requireClearingUser(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    throw new ValidationError('A clearing is accepted by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot accept a match. Every ledger write on ' +
          'this path is a decision somebody made (D-43), and this is where it is recorded.',
      },
    ]);
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Duplicate translation and read-back
// ---------------------------------------------------------------------------

async function translateClearingDuplicate(
  db: TenantDatabase,
  error: unknown,
  lineId: Buffer,
  computations: readonly ClearingEntryComputation[],
): Promise<PreconditionFailedError> {
  // The key name is the reliable signal, and the only one under a real race: the
  // winner committed *after* this transaction's snapshot opened, so a re-query here
  // sees neither its clearing row nor the journal it took — REPEATABLE READ hides
  // both. mysql2 names the violated index in the message (`… for key 'uq_blce_journal'`),
  // which does not depend on visibility.
  const key = duplicateKeyName(error);
  if (key.includes('uq_blce_journal')) return journalAlreadyCleared();
  if (key.includes('uq_blc_line')) return statementLineAlreadyCleared();

  // No key name (an older driver, or a differently-shaped error): fall back to the
  // re-query, which resolves the non-racing case where the conflicting row is visible.
  if ((await selectClearingByLine(db, lineId)) !== undefined) return statementLineAlreadyCleared();
  for (const computation of computations) {
    if ((await selectClearingIdByJournal(db, computation.clearedJournalId)) !== undefined) {
      return journalAlreadyCleared();
    }
  }
  return statementLineAlreadyCleared();
}

/** The unique index a duplicate-entry error names, or `''` if it cannot be read. */
function duplicateKeyName(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const message = (error as { readonly sqlMessage?: unknown; readonly message?: unknown })
    .sqlMessage;
  if (typeof message === 'string') return message;
  const fallback = (error as { readonly message?: unknown }).message;
  return typeof fallback === 'string' ? fallback : '';
}

function statementLineAlreadyCleared(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.STATEMENT_LINE_ALREADY_CLEARED,
    'This statement line has already been cleared. One movement of money is one statement line ' +
      'and one clearing; remove the existing clearing before accepting a different match.',
  );
}

function journalAlreadyCleared(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.JOURNAL_ALREADY_CLEARED,
    'This journal is already the entry another statement line was cleared against. One journal ' +
      'settles one entry; a second link would count the same money twice.',
  );
}

function assertFoundAfterWrite(row: ClearingRow | undefined): ClearingRow {
  if (row === undefined) {
    throw new InternalError(
      'The clearing just inserted could not be read back in its transaction.',
    );
  }
  return row;
}

/** The clearing as the wire returns it — parent plus its entries (D-105). */
export function assembleClearing(
  row: ClearingRow,
  entries: readonly ClearingEntryRow[],
): BankLineClearing {
  return {
    id: bufferToUuid(row.id),
    lineId: bufferToUuid(row.statement_line_id),
    entries: entries.map(toClearingEntry),
    clearedAmount: row.cleared_amount_minor.toString(),
    differenceAmount: row.difference_amount_minor.toString(),
    differenceAccountId:
      row.difference_account_id === null ? null : bufferToUuid(row.difference_account_id),
    differenceJournalId:
      row.difference_journal_id === null ? null : bufferToUuid(row.difference_journal_id),
    reconciliationSessionId:
      row.reconciliation_session_id === null ? null : bufferToUuid(row.reconciliation_session_id),
    clearedByUserId: bufferToUuid(row.created_by_user_id),
    clearedAt: row.created_at.toISOString(),
  };
}

function toClearingEntry(row: ClearingEntryRow): BankLineClearing['entries'][number] {
  return {
    id: bufferToUuid(row.id),
    entryType: row.entry_type,
    clearedJournalId: bufferToUuid(row.cleared_journal_id),
    paymentId: row.payment_id === null ? null : bufferToUuid(row.payment_id),
    accountId: row.account_id === null ? null : bufferToUuid(row.account_id),
    targetType: row.target_type,
    targetId: row.target_id === null ? null : bufferToUuid(row.target_id),
    amount: row.entry_amount_minor.toString(),
    createdAt: row.created_at.toISOString(),
  };
}
