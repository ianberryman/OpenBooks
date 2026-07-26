import type {
  JournalLineInput,
  PostJournalInput,
  PostedJournal,
  PostedJournalLine,
  PostingService,
  ReverseJournalInput,
} from '@openbooks/plugin-api';
import { fromMinorUnits, sum, toMinorUnits, ZERO } from '@openbooks/shared-types/money';
import type { Money } from '@openbooks/shared-types/money';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, orgScope, tenantDb, tryUuidToBuffer, uuidToBuffer } from '../../db';
import type { OrgId, TenantDatabase } from '../../db';
import {
  ConflictError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
} from '../../errors';
import { assertPostable } from '../periods';
import { requirePermission } from '../permissions';

import {
  allocateSequenceNumber,
  insertJournal,
  insertJournalLines,
  newJournalId,
  selectExistingReversal,
  selectJournalToReverse,
  selectPostableAccounts,
  type JournalLineRow,
} from './posting.repository';

/**
 * The ledger kernel: the sole implementation of `PostingService` (spec §8).
 *
 * This is the least clever code in the system by intent (spec §2.6). Every
 * financial object in OpenBooks resolves to a posting made here, so the value of
 * this file is that its rules are legible, not that they are compact.
 *
 * ## The order of operations is the design
 *
 * Everything happens in one transaction, and the sequence is chosen so that each
 * step fails as early as it can and holds locks for as short a time as possible:
 *
 *   1. permission — before the payload is examined, so an unauthorized caller
 *      learns nothing about the shape of the API they cannot use
 *   2. shape and balance — pure computation, no I/O, no locks
 *   3. accounts exist, are active, and are in this org — a plain read
 *   4. **period lock** (`assertPostable`, `FOR UPDATE`)
 *   5. **sequence lock** (`journal_sequences`, `FOR UPDATE`)
 *   6. insert header, insert lines
 *
 * Steps 4 and 5 are always taken in that order. Two locks acquired in a consistent
 * order across every caller cannot deadlock against each other; the reverse order
 * in one path would be a deadlock that appears only under concurrency, which is the
 * worst kind to find.
 *
 * Step 4 is what makes acceptance A9 hold — "posting racing a period lock leaves no
 * half-written journal." If `closePeriod` commits first, the locking read sees
 * `closed` and this rejects before writing anything. If this wins the race, the
 * close blocks on the period row until the posting commits or rolls back. Either
 * way there is no interleaving, and because both inserts are inside the same
 * transaction there is no partial journal even when it rolls back.
 */

const MIN_LINES = 2;

/**
 * The upper bound on lines in one journal, from `journal_lines.line_number`'s
 * `SMALLINT UNSIGNED` in `0002_ledger`.
 *
 * Bounded here so an over-long journal is a `validation_failed` rather than an
 * opaque `internal_error`. Without it, `line_number` overflowed at the driver and the
 * server took blame for a request it should have refused — the same shape as the
 * unbounded money string in D-13, and reachable from the MCP surface and the M6
 * workflow engine, not only from HTTP.
 *
 * Set to the schema's actual limit rather than to a smaller "reasonable" number on
 * purpose. The schema limit is a correctness constraint; a lower business limit
 * (payroll allocated across cost centres, a batched deposit in M4) would be product
 * policy, and inventing policy inside the kernel is how the kernel stops being
 * boring (spec §2.6).
 */
const MAX_LINES = 65_535;

export async function postJournal(
  input: PostJournalInput,
  ctx: RequestContext = getContext('postJournal()'),
): Promise<PostedJournal> {
  await requirePermission(ctx, 'journals.post');

  const orgId = orgScope(ctx.orgId);
  const lines = validateLines(input.lines);
  const actorId = requireActorId(input.actorId);

  return tenantDb(orgId).transaction(async (trx) => {
    await assertAccountsPostable(trx, lines);

    // Locks the period. Must precede the sequence lock — see the ordering note above.
    const period = await assertPostable(input.date);
    const sequenceNumber = await allocateSequenceNumber(trx, orgId);

    const journalId = newJournalId();
    await insertJournal(trx, {
      id: journalId,
      sequenceNumber,
      periodId: uuidToBuffer(period.id),
      entryDate: input.date,
      memo: input.memo ?? null,
      reference: null,
      source: 'manual',
      actorType: input.actorType,
      actorId,
      invocationMode: input.invocationMode ?? null,
      reversesJournalId: null,
    });
    await insertJournalLines(trx, toLineRows(journalId, lines));

    return readBack(trx, journalId, orgId);
  });
}

/**
 * Posts the reversal of an existing journal (spec §2.2, D-02).
 *
 * A new journal with every line's side inverted, carrying `reverses_journal_id`. The
 * original is not touched and cannot be — there is no `UPDATE` grant for it.
 *
 * The reversal takes its own date because the original's period is usually closed by
 * the time an error is found, and the reversal has to land somewhere postable. That
 * is a deliberate accounting choice, not a convenience: correcting a closed period
 * by reopening it restates figures already reported, whereas a reversal in the
 * current period leaves the closed period's statements intact and shows the
 * correction where it happened.
 */
export async function reverseJournal(
  input: ReverseJournalInput,
  ctx: RequestContext = getContext('reverseJournal()'),
): Promise<PostedJournal> {
  await requirePermission(ctx, 'journals.reverse');

  const orgId = orgScope(ctx.orgId);
  const actorId = requireActorId(input.actorId);
  // Malformed, another org's, and nonexistent must be one answer (A7), so a
  // malformed id becomes a lookup that finds nothing rather than its own error.
  const targetId = tryUuidToBuffer(input.journalId);

  return tenantDb(orgId).transaction(async (trx) => {
    const original = assertFound(
      targetId ? await selectJournalToReverse(trx, targetId) : undefined,
      'journal',
    );

    // uq_journals_org_reverses would reject a second reversal anyway; checking first
    // turns a driver duplicate-key error into an answer that names the reversal that
    // already exists. The unique key remains the actual guarantee — this check races
    // and the index does not.
    const existing = await selectExistingReversal(trx, original.id);
    if (existing) {
      throw new ConflictError(
        `Journal is already reversed by ${bufferToUuid(existing)}. A journal may be ` +
          'reversed once; reversing the reversal re-instates the original.',
      );
    }

    const period = await assertPostable(input.date);
    const sequenceNumber = await allocateSequenceNumber(trx, orgId);

    const journalId = newJournalId();
    await insertJournal(trx, {
      id: journalId,
      sequenceNumber,
      periodId: uuidToBuffer(period.id),
      entryDate: input.date,
      memo: input.memo ?? `Reversal of journal ${original.sequenceNumber.toString()}`,
      reference: null,
      source: 'reversal',
      actorType: input.actorType,
      actorId,
      invocationMode: input.invocationMode ?? null,
      reversesJournalId: original.id,
    });

    // Sides swap; amounts are untouched. Line numbers are re-derived rather than
    // copied so the reversal is a well-formed journal in its own right.
    await insertJournalLines(
      trx,
      original.lines.map((line, index) => ({
        journalId,
        lineNumber: index + 1,
        accountId: line.accountId,
        debitMinor: line.creditMinor,
        creditMinor: line.debitMinor,
        memo: line.memo,
      })),
    );

    return readBack(trx, journalId, orgId);
  });
}

/**
 * The `PostingService` token's implementation (spec §8).
 *
 * No cast is needed between `OperationContext` and `RequestContext`: OB-009 made the
 * latter an alias of the former rather than a competing type, precisely so there is
 * no conversion step in which an `orgId` could be rewritten.
 */
export const postingService: PostingService = { postJournal, reverseJournal };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidatedLine {
  readonly accountId: Buffer;
  readonly side: 'debit' | 'credit';
  readonly amount: Money;
  readonly memo: string | null;
}

/**
 * Shape and balance, in one pass, with every failure reported as a `ValidationError`
 * naming the offending line.
 *
 * The balance check is the definition of double-entry and acceptance A3. It is done
 * on `Money` (branded `bigint`) with `sum`, so it is exact — there is no tolerance
 * and no epsilon, because in minor units there is nothing for a tolerance to absorb.
 *
 * The schema enforces a related but weaker property: `chk_journal_lines_one_sided`
 * guarantees each line is one-sided and positive, and the composite keys guarantee
 * lines belong to their journal's org. What the schema *cannot* express is that the
 * lines of one journal sum to zero — that is a cross-row invariant, so it has to
 * live here, which is exactly why nothing else may insert into these tables.
 */
function validateLines(lines: readonly JournalLineInput[]): readonly ValidatedLine[] {
  const issues: { path: string; message: string }[] = [];

  if (lines.length < MIN_LINES) {
    issues.push({
      path: 'lines',
      message: `A journal needs at least ${String(MIN_LINES)} lines; received ${String(lines.length)}.`,
    });
  }

  if (lines.length > MAX_LINES) {
    // Returned immediately: the per-line loop below is O(n) and there is no reason to
    // walk 100,000 lines to report a length the first check already settled.
    throw new ValidationError('Journal has too many lines.', [
      {
        path: 'lines',
        message: `A journal may have at most ${String(MAX_LINES)} lines; received ${String(lines.length)}.`,
      },
    ]);
  }

  const validated: ValidatedLine[] = [];
  lines.forEach((line, index) => {
    const path = `lines.${String(index)}`;

    const accountId = tryUuidToBuffer(line.accountId);
    if (!accountId) {
      issues.push({ path: `${path}.accountId`, message: 'Not a valid account id.' });
    }

    // Strictly positive. The side carries the sign, so a negative amount is not an
    // alternative spelling of the other side — it is a caller that has confused the
    // two models, and guessing which they meant is how a debit becomes a credit.
    if (line.amount <= 0n) {
      issues.push({
        path: `${path}.amount`,
        message: 'Amount must be a positive number of minor units; the side carries the sign.',
      });
    }

    if (accountId && line.amount > 0n) {
      validated.push({
        accountId,
        side: line.side,
        amount: fromMinorUnits(line.amount),
        memo: line.memo ?? null,
      });
    }
  });

  if (issues.length === 0) {
    const debits = sum(validated.filter((l) => l.side === 'debit').map((l) => l.amount));
    const credits = sum(validated.filter((l) => l.side === 'credit').map((l) => l.amount));

    if (debits !== credits) {
      throw new ValidationError('Journal does not balance.', [
        {
          path: 'lines',
          message:
            `Debits total ${toMinorUnits(debits).toString()} and credits total ` +
            `${toMinorUnits(credits).toString()} minor units. A journal must balance exactly.`,
        },
      ]);
    }

    if (debits === ZERO) {
      // Every line positive and both sides equal can still sum to zero only if there
      // are no lines, which the arity check already caught — but a zero-value journal
      // is meaningless and this makes that explicit rather than incidental.
      throw new ValidationError('Journal has no value.', [
        { path: 'lines', message: 'A journal must move a non-zero amount.' },
      ]);
    }
  }

  if (issues.length > 0) {
    throw new ValidationError('Journal is not well formed.', issues);
  }

  return validated;
}

/**
 * Accounts must exist, be in this org, and be active.
 *
 * Existence and org membership are also guaranteed by the composite foreign key, so
 * this check exists for the *error surface*: without it another org's account id
 * arrives as MySQL errno 1452 and becomes a 500, where A7 requires the same 404 a
 * nonexistent id gets. `is_active` has no schema counterpart and is only checked
 * here — a deactivation racing this posting is possible and accepted, since the
 * account still exists and the posting is still balanced and attributable.
 */
async function assertAccountsPostable(
  db: TenantDatabase,
  lines: readonly ValidatedLine[],
): Promise<void> {
  const ids = [
    ...new Map(lines.map((line) => [line.accountId.toString('hex'), line.accountId])).values(),
  ];
  const accounts = await selectPostableAccounts(db, ids);

  const missing = ids.filter((id) => !accounts.has(id.toString('hex')));
  if (missing.length > 0) {
    throw new NotFoundError('account');
  }

  const inactive = ids.filter((id) => accounts.get(id.toString('hex'))?.isActive === false);
  if (inactive.length > 0) {
    throw new PreconditionFailedError(
      'account_inactive',
      `Cannot post to a deactivated account (${inactive.map((id) => bufferToUuid(id)).join(', ')}).`,
    );
  }
}

/**
 * Actor provenance is not optional (spec §6): every posting records who or what made
 * it. A missing actor is a wiring fault in the caller, not a client error — the
 * transport populates it from the resolved session.
 */
function requireActorId(actorId: string): Buffer {
  const buffer = tryUuidToBuffer(actorId);
  if (!buffer) {
    throw new ValidationError('Posting requires actor provenance.', [
      { path: 'actorId', message: 'Not a valid actor id.' },
    ]);
  }
  return buffer;
}

function toLineRows(journalId: Buffer, lines: readonly ValidatedLine[]): readonly JournalLineRow[] {
  return lines.map((line, index) => ({
    journalId,
    lineNumber: index + 1,
    accountId: line.accountId,
    debitMinor: line.side === 'debit' ? toMinorUnits(line.amount) : 0n,
    creditMinor: line.side === 'credit' ? toMinorUnits(line.amount) : 0n,
    memo: line.memo,
  }));
}

/**
 * Reads the posting back from inside the same transaction.
 *
 * Returning a value assembled in memory would report what this code *intended* to
 * write. Reading it back reports what the database accepted, which is the only claim
 * worth making about a ledger — and it is what surfaces a CHECK constraint or a
 * default the service did not account for.
 */
async function readBack(
  db: TenantDatabase,
  journalId: Buffer,
  orgId: OrgId,
): Promise<PostedJournal> {
  const journal = await db
    .selectFrom('journals')
    .selectAll()
    .where('journals.id', '=', journalId)
    .executeTakeFirstOrThrow();

  const lines = await db
    .selectFrom('journal_lines')
    .select(['id', 'line_number', 'account_id', 'debit_minor', 'credit_minor', 'memo'])
    .where('journal_lines.journal_id', '=', journalId)
    .orderBy('line_number')
    .execute();

  const postedLines: PostedJournalLine[] = lines.map((line) => ({
    // `journal_lines.id` is a BIGINT and internal (spec §4), stringified here rather
    // than exposed as a number so it cannot lose precision on the wire — the same
    // reason money is a string (D-13).
    lineId: line.id.toString(),
    accountId: bufferToUuid(line.account_id),
    // Derived from which column is non-zero, which chk_journal_lines_one_sided
    // guarantees is exactly one of them. Reading the side back from the data rather
    // than echoing the input is what makes this a report of what was stored.
    side: line.debit_minor > 0n ? 'debit' : 'credit',
    amount: line.debit_minor > 0n ? line.debit_minor : line.credit_minor,
    memo: line.memo,
  }));

  return {
    journalId: bufferToUuid(journal.id),
    orgId: bufferToUuid(orgId),
    date: journal.entry_date,
    memo: journal.memo,
    postedAt: journal.created_at.toISOString(),
    actorType: journal.actor_type,
    actorId: bufferToUuid(journal.actor_id),
    invocationMode: journal.invocation_mode,
    reversesJournalId: journal.reverses_journal_id
      ? bufferToUuid(journal.reverses_journal_id)
      : null,
    lines: postedLines,
  };
}
