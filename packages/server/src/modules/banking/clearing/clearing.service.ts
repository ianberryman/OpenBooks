import type { JournalLineInput, PostJournalInput } from '@openbooks/plugin-api';
import type {
  BankLineClearing,
  ClearBankStatementLineRequest,
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
import { recordPayment, voidPayment } from '../../payments';
import { requirePermission } from '../../permissions';
import type { SubledgerSide } from '../../settings';

import type { ClearingRow, StatementLineRow } from './clearing.repository';
import {
  BANK_ACCOUNT_RESOURCE,
  DOCUMENT_RESOURCE,
  JOURNAL_RESOURCE,
  STATEMENT_LINE_RESOURCE,
  deleteClearing,
  finalisedSessionCoversLine,
  insertClearing,
  journalBankMovement,
  journalExists,
  orgScope,
  selectBankAccount,
  selectClearingByLine,
  selectClearingIdByJournal,
  selectDocumentContactId,
  selectStatementLine,
} from './clearing.repository';

/**
 * Accepting a match: post, link, or allocate (OB-081; ROADMAP D-43, D-16, D-45;
 * acceptance E3, E4).
 *
 * This is where the banking pipeline first writes to the ledger, and it writes
 * because a human asked it to (D-43, E3). Nothing in `matching/` reaches this file;
 * a request carries what it wants done — an account to code to, a journal to link, a
 * document to settle — whether a proposal suggested it or a person typed it. There is
 * no `proposalId` it honours and no batch accept, which is the shape D-43 exists to
 * refuse.
 *
 * ## Every ledger write goes through the sanctioned service, never around it
 *
 * `post_entry` and the difference journal post through `postJournal`;
 * `allocate_document` records through `recordPayment` (which posts through
 * `postJournal` and allocates through M3's one mechanism, D-39); undo reverses
 * through `reverseJournal` and `voidPayment`. Balance validation, the period lock
 * (A4/A9) and actor provenance all live in those services, and this file
 * re-implements none of them — `openbooks/no-journal-writes` is what makes that
 * structural rather than a habit.
 *
 * ## E4 is an equation, held in the line's own frame
 *
 * A statement line carries a **signed** amount (`bank_statement_lines.amount_minor`),
 * and every clearing this file produces satisfies
 *
 *   clearedAmount + differenceAmount === line.amount
 *
 * signed, exactly, with no conditional (`assertClearingBalances`). The two agree
 * *because* the difference has been posted, not because it was dropped: a £990 line
 * clearing a £1,000 entry records +£1,000 cleared and −£10 to bank charges, and the
 * bank ledger moves by exactly the £990 the statement shows. A non-zero difference
 * with no account is `clearing_difference_unaccounted`; a `post_entry` cannot have a
 * difference at all, because its journal is created *for* the line (it agrees by
 * construction, `chk_blc_post_entry_exact`).
 *
 * ## Why there is no `FOR UPDATE` on the line or the journal
 *
 * Both are append-only at the grant level, and MySQL will not grant a locking read to
 * an identity without `UPDATE`/`DELETE` on the table (D-14). Two clearings racing the
 * same line or the same entry are serialized instead by `uq_blc_line` and
 * `uq_blc_journal` on insert, and the loser is translated to
 * `statement_line_already_cleared` / `journal_already_cleared` — the shape
 * `reverseJournal` uses for `uq_journals_org_reverses`, proven under two connections
 * in `clearing.race.test.ts`.
 *
 * ## The known role gap (OB-093), not papered over
 *
 * The service gates on `banking.match`. Beyond that, `post_entry` and any difference
 * reach `journals.post`; `allocate_document` reaches `payments_received.write` /
 * `payments_made.write` (by the line's sign) *and* `journals.post`; undo reaches
 * `journals.reverse`, and undo of an allocation reaches the payment write plus
 * `journals.reverse`. So a role holding `banking.match` but not the ledger codes can
 * accept a plain `link_entry` (which posts nothing) and is refused the rest — the
 * same gap OB-093 records for the AR/AP clerks, surfaced here rather than hidden.
 */

type ClearingComputation = {
  readonly method: ClearBankStatementLineRequest['method'];
  readonly clearedJournalId: Buffer;
  readonly paymentId: Buffer | null;
  readonly clearedAmount: bigint;
  readonly differenceAmount: bigint;
  readonly differenceAccountId: Buffer | null;
  readonly differenceJournalId: Buffer | null;
};

/**
 * Accepts a statement line three ways, and writes the one `bank_line_clearings` row.
 *
 * The order of operations: permission first (before the payload is examined), then
 * the line and its bank account, then the method's own work — which is the only part
 * that touches the ledger — then the E4 invariant, then the insert. Everything after
 * the permission is one transaction, so a journal posted by `post_entry` and the
 * clearing row that names it commit together: if the line turns out already cleared,
 * the journal rolls back with it rather than being orphaned.
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

    const computation = await computeClearing(trx, ctx, request, line, bankLedgerAccountId);

    // E4 as an invariant, not a check: the amounts are already constructed so this
    // holds, and it is here to refuse any future path that computed them independently.
    assertClearingBalances(
      computation.clearedAmount,
      computation.differenceAmount,
      line.amount_minor,
    );

    const id = newUuidBuffer();
    try {
      await insertClearing(trx, {
        id,
        statementLineId: lineBytes,
        method: computation.method,
        clearedJournalId: computation.clearedJournalId,
        paymentId: computation.paymentId,
        clearedAmountMinor: computation.clearedAmount,
        differenceAmountMinor: computation.differenceAmount,
        differenceAccountId: computation.differenceAccountId,
        differenceJournalId: computation.differenceJournalId,
        createdByUserId: author,
      });
    } catch (error: unknown) {
      // The losing side of a race the pre-checks could not see: `uq_blc_line` (this
      // line, by another clearing committed after our snapshot) or `uq_blc_journal`
      // (this entry, by a second `link_entry`). Re-derive which, so the answer is the
      // precondition the client can branch on rather than an opaque `internal_error`.
      if (isDuplicateEntryError(error)) {
        throw await translateClearingDuplicate(trx, error, lineBytes, computation.clearedJournalId);
      }
      throw error;
    }

    return toClearing(assertFoundAfterWrite(await selectClearingByLine(trx, lineBytes)));
  });
}

/**
 * Undoing a clearing: remove the link, and reverse whatever this clearing posted.
 *
 * Never a deletion of a journal (D-16). A `post_entry` reverses its journal; an
 * `allocate_document` voids its payment (reversing that journal and deleting its
 * allocations, M3's own undo); a `link_entry` reverses only a difference it posted,
 * and never the entry it linked — that entry existed before the clearing and outlives
 * it. The reversal's date must fall in an open period (`removeBankLineClearingRequest`),
 * which is why undo carries one even for the `link_entry` that reverses nothing.
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
    const line = assertFound(await selectStatementLine(trx, lineBytes), STATEMENT_LINE_RESOURCE);

    const clearing = await selectClearingByLine(trx, lineBytes);
    if (clearing === undefined) {
      throw new PreconditionFailedError(
        BANKING_PRECONDITIONS.STATEMENT_LINE_NOT_CLEARED,
        'This statement line has no clearing to remove. There is nothing to un-match.',
      );
    }

    if (await finalisedSessionCoversLine(trx, line.bank_account_id, line.posted_date)) {
      throw new PreconditionFailedError(
        BANKING_PRECONDITIONS.RECONCILIATION_SESSION_ALREADY_FINALISED,
        'A finalised reconciliation session counts this line, so its clearing cannot be undone: ' +
          'doing so would silently falsify the balance that session asserted (E6). Reopen the ' +
          'session first — reopening is permission-gated and recorded, and it is the way in.',
      );
    }

    if (clearing.method === 'allocate_document' && clearing.payment_id !== null) {
      // Voids the payment: reverses its journal (which is `cleared_journal_id`) and
      // deletes the allocations it made, so what it settled is outstanding again.
      await voidPayment(
        bufferToUuid(clearing.payment_id),
        {
          date: request.date,
          ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
        },
        ctx,
      );
    } else if (clearing.method === 'post_entry') {
      await reverseClearingJournal(ctx, clearing.cleared_journal_id, request);
    }
    // A `link_entry` never reverses `cleared_journal_id`: it did not post it.

    if (clearing.difference_journal_id !== null) {
      await reverseClearingJournal(ctx, clearing.difference_journal_id, request);
    }

    await deleteClearing(trx, clearing.id);
  });
}

// ---------------------------------------------------------------------------
// The three methods
// ---------------------------------------------------------------------------

async function computeClearing(
  trx: TenantDatabase,
  ctx: RequestContext,
  request: ClearBankStatementLineRequest,
  line: StatementLineRow,
  bankLedgerAccountId: Buffer,
): Promise<ClearingComputation> {
  const bankLedgerUuid = bufferToUuid(bankLedgerAccountId);

  switch (request.method) {
    case 'post_entry': {
      // The journal is created for the line, dated the line's own date (D-45), so it
      // agrees by construction: cleared = line, no difference is possible.
      const posted = await postJournal(
        postInput(ctx, line.posted_date, request.memo, [
          bankMovementLine(bankLedgerUuid, line.amount_minor),
          codedLine(
            request.accountId,
            line.amount_minor,
            request.contactId,
            request.dimensionValueIds,
          ),
        ]),
        ctx,
      );
      return {
        method: 'post_entry',
        clearedJournalId: uuidToBuffer(posted.journalId),
        paymentId: null,
        clearedAmount: line.amount_minor,
        differenceAmount: 0n,
        differenceAccountId: null,
        differenceJournalId: null,
      };
    }

    case 'link_entry': {
      const journalId = assertFound(tryUuidToBuffer(request.journalId), JOURNAL_RESOURCE);
      if (!(await journalExists(trx, journalId))) throw new NotFoundError(JOURNAL_RESOURCE);

      const alreadyCleared = await selectClearingIdByJournal(trx, journalId);
      if (alreadyCleared !== undefined) throw journalAlreadyCleared();

      const clearedAmount = await journalBankMovement(trx, journalId, bankLedgerAccountId);
      const differenceAmount = line.amount_minor - clearedAmount;
      const difference = await resolveDifference(
        ctx,
        line.posted_date,
        bankLedgerUuid,
        differenceAmount,
        request.differenceAccountId,
      );

      return {
        method: 'link_entry',
        clearedJournalId: journalId,
        paymentId: null,
        clearedAmount,
        differenceAmount,
        differenceAccountId: difference.accountId,
        differenceJournalId: difference.journalId,
      };
    }

    case 'allocate_document': {
      const side: SubledgerSide = request.targetType === 'invoice' ? 'receivable' : 'payable';
      const direction = paymentDirectionFor(line.amount_minor);

      const settle = resolveSettleAmount(request.amount, line.amount_minor);
      const clearedAmount = direction === 'received' ? settle : -settle;
      const differenceAmount = line.amount_minor - clearedAmount;

      const targetId = assertFound(tryUuidToBuffer(request.targetId), DOCUMENT_RESOURCE);
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
          ...(request.memo === undefined || request.memo === null ? {} : { memo: request.memo }),
          allocations: [
            {
              targetType: request.targetType,
              targetId: request.targetId,
              amount: settle.toString(),
            },
          ],
        },
        ctx,
      );

      const difference = await resolveDifference(
        ctx,
        line.posted_date,
        bankLedgerUuid,
        differenceAmount,
        request.differenceAccountId,
      );

      return {
        method: 'allocate_document',
        clearedJournalId: uuidToBuffer(payment.journalId),
        paymentId: uuidToBuffer(payment.id),
        clearedAmount,
        differenceAmount,
        differenceAccountId: difference.accountId,
        differenceJournalId: difference.journalId,
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
        'the line and the entry it clears, and no account was given to post it to. E4 requires ' +
        'the difference to be recorded — a bank charge or a short payment is an entry in the ' +
        'books, not a number absorbed on a screen. Name an account for it, or clear the whole ' +
        'of the line against an entry that agrees with it exactly.',
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
 * E4, at the write: a cleared line and the entry it clears agree exactly on amount.
 *
 * `clearedAmount + differenceAmount === line.amount`, signed, in the line's frame.
 * Exported so the property suite can assert it in isolation, including the inputs the
 * service cannot produce — a mismatch here is a coding fault, and this is where it is
 * refused rather than silently written.
 */
export function assertClearingBalances(
  clearedAmount: bigint,
  differenceAmount: bigint,
  lineAmount: bigint,
): void {
  const accounted = clearedAmount + differenceAmount;
  if (accounted !== lineAmount) {
    throw new PreconditionFailedError(
      BANKING_PRECONDITIONS.CLEARING_AMOUNT_MISMATCH,
      `A clearing must account for the whole of the line. Cleared ${clearedAmount.toString()} ` +
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
  lineAmount: bigint,
  contactId: string | null | undefined,
  dimensionValueIds: readonly string[] | undefined,
): JournalLineInput {
  return {
    accountId,
    // Opposite the bank: money in (line > 0) debits the bank and credits the account
    // it came from, and money out is the mirror.
    side: lineAmount > 0n ? 'credit' : 'debit',
    amount: magnitude(lineAmount),
    ...(contactId === undefined || contactId === null ? {} : { contactId }),
    ...(dimensionValueIds === undefined ? {} : { dimensionValueIds: [...dimensionValueIds] }),
  };
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
        path: 'method',
        message:
          'This statement line moved no money, so there is no invoice or bill it can settle. ' +
          'A zero-amount line is coded (`post_entry`) or linked (`link_entry`), not allocated.',
      },
    ]);
  }
  return lineAmount > 0n ? 'received' : 'made';
}

/**
 * How much of the document to settle, as a positive magnitude — the request's `amount`
 * or, by default, the whole of the line (the ordinary case, where the payment is
 * exactly what the statement shows).
 */
function resolveSettleAmount(amount: string | null | undefined, lineAmount: bigint): bigint {
  if (amount === undefined || amount === null) return magnitude(lineAmount);

  // The schema's `minorUnitsSchema` accepts a signed, canonical string; a settlement
  // is a positive magnitude, so a non-positive one is a client that has confused the
  // frame — the line's sign is what carries the direction, not this number.
  const parsed = BigInt(amount);
  if (parsed <= 0n) {
    throw new ValidationError('The settlement amount must be a positive magnitude.', [
      {
        path: 'amount',
        message:
          'This is how much of the document to settle, always positive; the line’s own sign ' +
          'decides whether the money was received or paid.',
      },
    ]);
  }
  return parsed;
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
  clearedJournalId: Buffer,
): Promise<PreconditionFailedError> {
  // The key name is the reliable signal, and the only one under a real race: the
  // winner committed *after* this transaction's snapshot opened, so a re-query here
  // sees neither its clearing row nor the journal it took — REPEATABLE READ hides
  // both. mysql2 names the violated index in the message (`… for key 'uq_blc_journal'`),
  // which does not depend on visibility.
  const key = duplicateKeyName(error);
  if (key.includes('uq_blc_journal')) return journalAlreadyCleared();
  if (key.includes('uq_blc_line')) return statementLineAlreadyCleared();

  // No key name (an older driver, or a differently-shaped error): fall back to the
  // re-query, which resolves the non-racing case where the conflicting row is visible.
  if ((await selectClearingByLine(db, lineId)) !== undefined) return statementLineAlreadyCleared();
  if ((await selectClearingIdByJournal(db, clearedJournalId)) !== undefined) {
    return journalAlreadyCleared();
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
      'and one entry; remove the existing clearing before accepting a different match.',
  );
}

function journalAlreadyCleared(): PreconditionFailedError {
  return new PreconditionFailedError(
    BANKING_PRECONDITIONS.JOURNAL_ALREADY_CLEARED,
    'This journal is already the entry another statement line was cleared against. One journal ' +
      'settles one line; a second link would count the same money twice.',
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

function toClearing(row: ClearingRow): BankLineClearing {
  return {
    id: bufferToUuid(row.id),
    lineId: bufferToUuid(row.statement_line_id),
    method: row.method,
    clearedJournalId: bufferToUuid(row.cleared_journal_id),
    clearedAmount: row.cleared_amount_minor.toString(),
    differenceAmount: row.difference_amount_minor.toString(),
    differenceAccountId:
      row.difference_account_id === null ? null : bufferToUuid(row.difference_account_id),
    differenceJournalId:
      row.difference_journal_id === null ? null : bufferToUuid(row.difference_journal_id),
    paymentId: row.payment_id === null ? null : bufferToUuid(row.payment_id),
    reconciliationSessionId:
      row.reconciliation_session_id === null ? null : bufferToUuid(row.reconciliation_session_id),
    clearedByUserId: bufferToUuid(row.created_by_user_id),
    clearedAt: row.created_at.toISOString(),
  };
}
