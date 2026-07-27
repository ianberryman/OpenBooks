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
import {
  bufferToUuid,
  isDuplicateEntryError,
  orgScope,
  tenantDb,
  tryUuidToBuffer,
  uuidToBuffer,
} from '../../db';
import type { OrgId, TenantDatabase } from '../../db';
import {
  ConflictError,
  InternalError,
  NotFoundError,
  PreconditionFailedError,
  ValidationError,
  assertFound,
} from '../../errors';
import { resolveTagsForNewLine } from '../dimensions';
import type { ResolvedLineTag } from '../dimensions';
import { assertPostable } from '../periods';
import { requirePermission } from '../permissions';

import {
  allocateSequenceNumber,
  insertJournal,
  insertJournalLineDimensions,
  insertJournalLines,
  newJournalId,
  selectExistingReversal,
  selectJournalLineIds,
  selectJournalTags,
  selectJournalToReverse,
  selectPostableAccounts,
  selectPostableContacts,
  type JournalLineRow,
  type JournalLineTagRow,
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
 *   3. accounts and contacts exist, are active, and are in this org — plain reads;
 *      and each line's dimension values resolved, which takes a **row lock on
 *      `dimension_values`** (OB-059)
 *   4. **period lock** (`assertPostable`, `FOR UPDATE`)
 *   5. **sequence lock** (`journal_sequences`, `FOR UPDATE`)
 *   6. insert header, insert lines, insert the lines' tags
 *
 * Steps 4 and 5 are always taken in that order. Two locks acquired in a consistent
 * order across every caller cannot deadlock against each other; the reverse order
 * in one path would be a deadlock that appears only under concurrency, which is the
 * worst kind to find.
 *
 * The `dimension_values` lock step 3 takes is the same one a retag takes, and it is
 * deliberately taken *before* the period and the sequence: it serializes this
 * posting against `deleteDimensionValue` (without it, the losing order is errno 1452
 * on the tag insert — a 500 for what is plainly a client's situation), and nothing
 * anywhere takes the period or the sequence and then reaches for a dimension row, so
 * the global order stays total. It also means the two rows every poster in the org
 * contends on are held for as little of the call as possible.
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
    await assertContactsPostable(trx, lines);
    const tags = await resolveTags(trx, lines);

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
    await insertJournalLineDimensions(trx, await toTagRows(trx, journalId, tags));

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

    // uq_journals_org_reverses is the guarantee; this check only produces a better
    // message. It races, and the index does not.
    const existing = await selectExistingReversal(trx, original.id);
    if (existing) {
      throw alreadyReversed(existing);
    }

    const period = await assertPostable(input.date);
    const sequenceNumber = await allocateSequenceNumber(trx, orgId);

    const journalId = newJournalId();
    try {
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
    } catch (error: unknown) {
      // The losing side of a concurrent reversal, translated.
      //
      // The pre-check above cannot see a reversal that another transaction has not yet
      // committed, so under real contention both callers reach this insert and one
      // violates uq_journals_org_reverses. The *guarantee* was never in doubt — exactly
      // one reversal exists either way — but the raw ER_DUP_ENTRY propagated to
      // `toWireError` as an opaque `internal_error`, reporting a server fault for a
      // request the system understood and correctly refused. Found by OB-026 under two
      // real connections; the sequential test could not reach it.
      if (isDuplicateEntryError(error)) {
        throw alreadyReversed(await selectExistingReversal(trx, original.id));
      }
      throw error;
    }

    // Sides swap; amounts are untouched. Line numbers are re-derived rather than
    // copied so the reversal is a well-formed journal in its own right.
    //
    // The contact is copied, and it is copied for the same reason the account and
    // the memo are: it is a column of the line being reversed, and a reversal that
    // dropped it would answer "what is still outstanding with this customer" with
    // the debit and not the credit. It is copied *without* the active check
    // `postJournal` applies, matching the account: a reversal must be able to undo
    // an entry naming something since deactivated, or a mistake becomes permanent
    // by the act of tidying the contact list.
    //
    // The tags are deliberately not copied. A tag is mutable analysis (D-32) and
    // the reversal happens later, so copying would freeze whatever the original
    // happened to carry at that moment into a second, independent line — and the
    // correction a reversal makes is frequently *why* the tagging is about to
    // change. Tagging the reversal is `setJournalLineDimensions`, which is the
    // operation for saying which slice an amount that already exists belongs to.
    await insertJournalLines(
      trx,
      original.lines.map((line, index) => ({
        journalId,
        lineNumber: index + 1,
        accountId: line.accountId,
        contactId: line.contactId,
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
  readonly contactId: Buffer | null;
  readonly side: 'debit' | 'credit';
  readonly amount: Money;
  readonly memo: string | null;
  readonly dimensionValueIds: readonly string[];
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

    // Mirrors the account beside it: a malformed id is a validation failure naming
    // the field, while an unknown or another org's is the single 404
    // `assertContactsPostable` produces. A7 is satisfied either way — it requires a
    // cross-org id to be indistinguishable from a nonexistent one, and both are —
    // and one convention for the two reference fields on a line is worth more than
    // matching what the drafts service does with the same id.
    const contactId = line.contactId === undefined ? null : tryUuidToBuffer(line.contactId);
    if (contactId === undefined) {
      issues.push({ path: `${path}.contactId`, message: 'Not a valid contact id.' });
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

    if (accountId && contactId !== undefined && line.amount > 0n) {
      validated.push({
        accountId,
        contactId,
        side: line.side,
        amount: fromMinorUnits(line.amount),
        memo: line.memo ?? null,
        dimensionValueIds: line.dimensionValueIds ?? [],
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
 * Contacts must exist, be in this org, and be active (OB-059).
 *
 * `assertAccountsPostable`'s twin, and it exists for the same error surface:
 * `fk_journal_lines_contact` also guarantees existence and org membership, but
 * another org's contact id arrives as MySQL errno 1452 and becomes a 500, where A7
 * requires the same 404 a nonexistent id gets.
 *
 * **An inactive contact may not be named on a new posting.** `modules/contacts`
 * left this open deliberately — "it belongs with whichever ticket tags a posted
 * line" — and this is that ticket. Deactivation is what an org does to take a
 * contact out of circulation while keeping its history, so an entry naming it anew
 * puts it straight back in, and the picker's active filter and the ledger's answer
 * would disagree. The same rule as the account, refused the same way, so a user
 * cannot learn one convention for one field and a different one for the field
 * beside it.
 *
 * The cost is real and is the account's cost too: a draft composed while a contact
 * was active and posted after it was deactivated is refused, and the fix is to
 * reactivate the contact (`reactivateContact` exists precisely so deactivation is
 * not a one-way door) or clear the line's contact. A reversal is *not* subject to
 * this, for the reason given at the copy in `reverseJournal`.
 */
async function assertContactsPostable(
  db: TenantDatabase,
  lines: readonly ValidatedLine[],
): Promise<void> {
  const ids = [
    ...new Map(
      lines
        .map((line) => line.contactId)
        .filter((id): id is Buffer => id !== null)
        .map((id) => [id.toString('hex'), id]),
    ).values(),
  ];
  if (ids.length === 0) return;

  const contacts = await selectPostableContacts(db, ids);

  if (ids.some((id) => !contacts.has(id.toString('hex')))) {
    throw new NotFoundError('contact');
  }

  const inactive = ids.filter((id) => contacts.get(id.toString('hex'))?.isActive === false);
  if (inactive.length > 0) {
    throw new PreconditionFailedError(
      'contact_inactive',
      `Cannot post a line naming a deactivated contact (${inactive
        .map((id) => bufferToUuid(id))
        .join(', ')}). Reactivate it, or clear the contact from the line.`,
    );
  }
}

/**
 * Each line's tags, resolved through the module that owns them (OB-059).
 *
 * Resolved before the period and the sequence are locked, and resolved by the
 * dimensions service rather than here: the refusals a tag can earn — unknown,
 * cross-org, archived, two values on one axis — are that module's rules, and a
 * second implementation of them would be a second answer to the same question.
 * Why this needs no permission beyond `journals.post` is argued on
 * `resolveTagsForNewLine`.
 */
async function resolveTags(
  db: TenantDatabase,
  lines: readonly ValidatedLine[],
): Promise<readonly (readonly ResolvedLineTag[])[]> {
  const resolved: (readonly ResolvedLineTag[])[] = [];
  for (const line of lines) {
    resolved.push(await resolveTagsForNewLine(line.dimensionValueIds, db));
  }
  return resolved;
}

/**
 * The tags as rows, against the ids the lines were actually stored under.
 *
 * The line ids are read back rather than assumed, for the reason
 * `selectJournalLineIds` gives. A line number with no id is impossible — the lines
 * were inserted under this journal in this transaction — and it throws rather than
 * defaulting, because the only available default would attach a tag to some other
 * line.
 */
async function toTagRows(
  db: TenantDatabase,
  journalId: Buffer,
  tags: readonly (readonly ResolvedLineTag[])[],
): Promise<readonly JournalLineTagRow[]> {
  if (tags.every((line) => line.length === 0)) return [];

  const idsByLineNumber = await selectJournalLineIds(db, journalId);

  return tags.flatMap((lineTags, index) => {
    if (lineTags.length === 0) return [];

    const lineNumber = index + 1;
    const lineId = idsByLineNumber.get(lineNumber);
    if (lineId === undefined) {
      throw new InternalError(
        `Journal line ${String(lineNumber)} was inserted and could not be read back; its tags ` +
          'cannot be attached to a line that is not there.',
      );
    }

    return lineTags.map((tag) => ({
      lineId,
      dimensionId: tag.dimensionId,
      dimensionValueId: tag.dimensionValueId,
    }));
  });
}

/**
 * Actor provenance is not optional (spec §6): every posting records who or what made
 * it. A missing actor is a wiring fault in the caller, not a client error — the
 * transport populates it from the resolved session.
 */
/**
 * One construction of the already-reversed conflict, used by both the pre-check and
 * the duplicate-key path, so the two cannot drift into differently-worded answers for
 * the same condition.
 *
 * `existing` may be undefined on the losing side of a race whose winner committed
 * after this transaction's snapshot: the guarantee still held, so the answer is still
 * a conflict, just without an id to name.
 */
function alreadyReversed(existing: Buffer | undefined): ConflictError {
  const suffix = existing === undefined ? '' : ` by ${bufferToUuid(existing)}`;
  return new ConflictError(
    `Journal is already reversed${suffix}. A journal may be reversed once; reversing ` +
      'the reversal re-instates the original.',
  );
}

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
    contactId: line.contactId,
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
    .select([
      'id',
      'line_number',
      'account_id',
      'contact_id',
      'debit_minor',
      'credit_minor',
      'memo',
    ])
    .where('journal_lines.journal_id', '=', journalId)
    .orderBy('line_number')
    .execute();

  const tags = await selectJournalTags(
    db,
    lines.map((line) => line.id),
  );

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
    contactId: line.contact_id === null ? null : bufferToUuid(line.contact_id),
    dimensionValueIds: (tags.get(line.id.toString()) ?? []).map((value) => bufferToUuid(value)),
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
