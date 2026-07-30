import type { JournalLineInput, PostJournalInput, PostedJournal } from '@openbooks/plugin-api';
import type {
  CreateDraftRequest,
  DraftLineInput,
  JournalDraft,
  JournalDraftPage,
  ListDraftsQuery,
  UpdateDraftRequest,
} from '@openbooks/shared-types';
import {
  createDraftRequestSchema,
  listDraftsQuerySchema,
  updateDraftRequestSchema,
} from '@openbooks/shared-types';
import { fromMinorString, toMinorUnits } from '@openbooks/shared-types/money';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import type { TenantDatabase } from '../../db';
import { bufferToUuid, resolvePageLimit, tryUuidToBuffer } from '../../db';
import type { ValidationIssue } from '../../errors';
import {
  assertFound,
  InternalError,
  NotFoundError,
  parseInput,
  PreconditionFailedError,
  ValidationError,
} from '../../errors';
import { postJournal } from '../ledger';
import { requirePermission } from '../permissions';

import type { DraftEntryType, DraftFilters, NewDraftLineRow } from './drafts.repository';
import {
  DRAFT_RESOURCE as RESOURCE,
  deleteDraftRow,
  draftIdBytes,
  insertDraft,
  newDraftId,
  orgScope,
  replaceDraftLines,
  selectDimensionAxes,
  selectDraftById,
  selectDraftByIdForUpdate,
  selectDraftLineDimensions,
  selectDraftLines,
  selectDraftsPage,
  selectExistingAccountIds,
  selectExistingContactIds,
  toDraft,
  toDraftSummary,
  updateDraftRow,
} from './drafts.repository';

/**
 * Journal drafts (OB-038; ROADMAP D-16, D-19).
 *
 * Read `index.ts` for what a draft *is* and why it needed its own tables. Three
 * things are uniform across every operation here and are stated once:
 *
 * 1. **`requirePermission` runs first**, before the payload is parsed, so an
 *    unauthorized caller learns nothing about the shape of an API they cannot
 *    use. Enforcement is service-layer only (spec §2.4, §5).
 * 2. **Every payload is parsed with a shared zod schema**, because the HTTP route
 *    is not the only caller (spec §12; see `input.ts`).
 * 3. **A miss is `assertFound`**, never a hand-written throw. `tenantDb` has
 *    already confined every read to the context's org, so a cross-org id returns
 *    no row and reaches the same line a nonexistent id reaches (A7).
 */

/**
 * Creates a draft, with or without lines.
 *
 * `journals.post` and not a permission of its own. That choice is argued in full
 * in `index.ts`; the short form is that a draft is an entry on its way to the
 * ledger, and nothing in M2 distinguishes a caller who may compose one from a
 * caller who may post it.
 *
 * The transaction is unconditional even when there are no lines: `TenantDatabase`
 * joins an ambient one (`transaction-scope.ts`), so the cost when there is
 * nothing to protect is one `BEGIN`, and with lines it is what keeps a draft from
 * existing for a moment without them.
 */
export async function createDraft(
  input: CreateDraftRequest,
  ctx: RequestContext = getContext('createDraft()'),
): Promise<JournalDraft> {
  await requirePermission(ctx, 'journals.post');
  const request = parseInput(createDraftRequestSchema, input);
  const author = requireAuthor(ctx);

  return orgScope(ctx).transaction(async (trx) => {
    const id = newDraftId();

    await insertDraft(trx, id, {
      createdByUserId: author,
      entryDate: request.entryDate ?? null,
      memo: request.memo ?? null,
      reference: request.reference ?? null,
      ...(request.entryType === undefined ? {} : { entryType: request.entryType }),
    });

    if (request.lines !== undefined) {
      await replaceDraftLines(trx, id, await resolveLines(trx, request.lines));
    }

    return readDraft(trx, id);
  });
}

export async function getDraft(
  draftId: string,
  ctx: RequestContext = getContext('getDraft()'),
): Promise<JournalDraft> {
  await requirePermission(ctx, 'journals.read');

  const db = orgScope(ctx);
  return readDraft(db, assertFound(draftIdBytes(draftId), RESOURCE));
}

/**
 * One page of the org's drafts, oldest first (D-21).
 *
 * `resolvePageLimit` and not the parsed `limit`, even though the schema declares
 * the same bounds: the schema is a restatement for `openapi.json`'s benefit and
 * the function is the authority, because spec §12 puts an MCP tool and the
 * workflow engine on this service with no schema in front of them.
 */
export async function listDrafts(
  query: ListDraftsQuery,
  ctx: RequestContext = getContext('listDrafts()'),
): Promise<JournalDraftPage> {
  await requirePermission(ctx, 'journals.read');
  const request = parseInput(listDraftsQuerySchema, query);
  const limit = resolvePageLimit(request.limit);

  const filters: DraftFilters = {
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    // A well-formed id belonging to nobody is an empty page, not an error: the
    // filter names an author, and "this author has no drafts" is the honest
    // answer whether or not the author exists in this org.
    ...(request.createdByUserId === undefined
      ? {}
      : { createdByUserId: tryUuidToBuffer(request.createdByUserId) }),
  };

  const page = await selectDraftsPage(orgScope(ctx), filters, limit);
  return { items: page.rows.map(toDraftSummary), nextCursor: page.nextCursor };
}

/**
 * Updates the header, and — when `lines` is present — replaces the whole line set.
 *
 * The draft row is taken `FOR UPDATE` before anything is written. Two reasons,
 * and the second is the one that matters:
 *
 *  - two concurrent edits of one draft serialize instead of interleaving a header
 *    patch with a line replacement;
 *  - an edit racing `postDraft` cannot land between the post's validation and its
 *    delete. Without the lock, a line added after the posting read its lines would
 *    be discarded with the draft and never reach the ledger — the user's edit
 *    would be silently lost, and the draft would be gone to prove it.
 */
export async function updateDraft(
  draftId: string,
  input: UpdateDraftRequest,
  ctx: RequestContext = getContext('updateDraft()'),
): Promise<JournalDraft> {
  await requirePermission(ctx, 'journals.post');
  const request = parseInput(updateDraftRequestSchema, input);

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(draftIdBytes(draftId), RESOURCE);
    assertFound(await selectDraftByIdForUpdate(trx, id), RESOURCE);

    await updateDraftRow(
      trx,
      id,
      {
        ...(request.entryDate === undefined ? {} : { entryDate: request.entryDate }),
        ...(request.memo === undefined ? {} : { memo: request.memo }),
        ...(request.reference === undefined ? {} : { reference: request.reference }),
        ...(request.entryType === undefined ? {} : { entryType: request.entryType }),
      },
      new Date(),
    );

    if (request.lines !== undefined) {
      await replaceDraftLines(trx, id, await resolveLines(trx, request.lines));
    }

    return readDraft(trx, id);
  });
}

/**
 * Discards a draft and everything on it.
 *
 * This is the operation D-16 is about: an entry that has not reached the ledger
 * is deleted outright, because deleting it removes nothing an auditor could ask
 * about — no report changes and no past date stops reproducing, since a draft was
 * never in one. The ledger's own answer to a mistake is unchanged and unchangeable
 * (a reversal); this is why that answer no longer has to cover typos.
 *
 * No explicit lock. The `DELETE` takes the row's exclusive lock itself, so a
 * discard racing a post is settled by whichever reaches the row first: if the post
 * wins, this deletes zero rows and reports a miss; if this wins, the post's
 * locking read finds nothing and reports the same miss. Both orders leave exactly
 * one outcome and no half-state.
 */
export async function discardDraft(
  draftId: string,
  ctx: RequestContext = getContext('discardDraft()'),
): Promise<void> {
  await requirePermission(ctx, 'journals.post');

  const db = orgScope(ctx);
  const id = assertFound(draftIdBytes(draftId), RESOURCE);

  if ((await deleteDraftRow(db, id)) === 0) throw new NotFoundError(RESOURCE);
}

/**
 * Posts a draft to the ledger, and discards it, in **one transaction** (D-19).
 *
 * ## Why one transaction is the requirement and not an optimization
 *
 * Two transactions would let a crash between them leave a posted journal and a
 * live draft of it. The user would then post the same entry twice believing the
 * first had failed — and the second posting is a real journal that cannot be
 * deleted, only reversed, which is precisely the experience D-16 built drafts to
 * avoid. So the delete is not cleanup after a successful post; it is part of it.
 *
 * ## The locking shape, in order
 *
 *   1. `journal_drafts` row, `FOR UPDATE` — the first statement in the
 *      transaction, so that a second poster of the same draft blocks here before
 *      it has read anything.
 *   2. period row, `FOR UPDATE` (`assertPostable`, inside `postJournal`)
 *   3. `journal_sequences` counter row, `FOR UPDATE` (inside `postJournal`)
 *
 * Every path that locks a draft locks it first, and `postJournal` always takes 2
 * before 3, so the global order is total and no two callers can deadlock against
 * each other. That the draft lock comes first is also what makes it useful: taken
 * after validation it would guard nothing, because the losing caller would
 * already have read a draft that is about to be deleted.
 *
 * ## Exactly once, and what the loser sees
 *
 * The mechanism is the row lock, not a status column and not a check-then-act.
 * The loser blocks on step 1 until the winner commits; the winner's commit has
 * deleted the row, and a locking read is a *current* read, so the loser's own
 * `SELECT … FOR UPDATE` then returns nothing and it reports a 404. One journal,
 * one refusal, no window in which both callers believe they hold the draft.
 *
 * A status column (`posted_at`) was the alternative and it is worse in a way worth
 * recording: it would leave the draft behind after a successful post, so the
 * ledger and the drafts list would both hold the same entry — and every later
 * reader would need to remember which state means which. Deleting says it once.
 *
 * ## Where validation happens, and why not before now
 *
 * Everything a journal requires is nullable on a draft, so the checks are made
 * here, and their failure is a message to the person posting rather than a
 * constraint violation while they type. This function only checks what
 * `postJournal` cannot see — a missing date, a line with no account, a line with
 * no side or with both — and hands the rest over. Balance, arity, positivity, the
 * accounts' existence and activity, and the period lock are all `postJournal`'s,
 * which is the only path to the journal tables (`openbooks/no-journal-writes`)
 * and holds the checks that make a posting a posting.
 *
 * A failed post leaves the draft **intact**, which is the whole value of the draft
 * surviving a rejected post: the transaction rolls back, the draft's row lock is
 * released, and the user sees the entry they were editing plus the reason it was
 * refused.
 *
 * ## The line's contact and its tags travel with it (OB-059)
 *
 * A draft line carries a `contactId` and dimension tags — the journal-entry form
 * collects both (OB-051) — and both are handed to `postJournal` as part of the line.
 * Nothing here writes either one: `journal_lines.contact_id` is a column of the
 * line, and `journal_line_dimensions` is written by `posting.repository.ts` in the
 * posting's own transaction, so this module gains no write path into anybody else's
 * invariant and the entry commits with everything entered on it or not at all.
 *
 * They were dropped before, pinned by a test, and the drop was invisible in exactly
 * the way that matters: B6's "slices plus unassigned equals the whole" still held,
 * because an untagged line lands in the unassigned bucket. What was missing was the
 * slice — the sliced report was short by exactly the entries somebody had tagged by
 * hand.
 */
export async function postDraft(
  draftId: string,
  ctx: RequestContext = getContext('postDraft()'),
): Promise<PostedJournal> {
  await requirePermission(ctx, 'journals.post');

  return orgScope(ctx).transaction(async (trx) => {
    const id = assertFound(draftIdBytes(draftId), RESOURCE);
    const draft = assertFound(await selectDraftByIdForUpdate(trx, id), RESOURCE);
    const lines = await selectDraftLines(trx, id);
    const tags = await selectDraftLineDimensions(
      trx,
      lines.map((line) => line.id),
    );

    // `postJournal` joins this transaction ambiently (`transaction-scope.ts`), so
    // the posting, the sequence allocation, and the delete below are one unit of
    // work on one connection. It is called, never re-implemented: balance
    // validation, the period lock, and actor provenance all live in it.
    //
    // The provenance is the *caller's*, not the draft author's. The journal
    // records who posted, which is the fact an auditor asks about; who drafted
    // stays on the draft, and the draft is about to stop existing.
    const posted = await postJournal(
      toPostJournalInput(draft.entry_date, draft.memo, draft.entry_type, lines, tags, ctx),
      ctx,
    );

    const deleted = await deleteDraftRow(trx, id);
    if (deleted !== 1) {
      throw new InternalError(
        `Posting a draft deleted ${String(deleted)} rows while holding its row lock. The draft ` +
          'was read FOR UPDATE in this transaction, so it cannot have been removed by another ' +
          'one — the journal is posted and a draft of it may survive (D-19).',
      );
    }

    return posted;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function readDraft(db: TenantDatabase, id: Buffer): Promise<JournalDraft> {
  const row = assertFound(await selectDraftById(db, id), RESOURCE);
  const lines = await selectDraftLines(db, id);
  const tags = await selectDraftLineDimensions(
    db,
    lines.map((line) => line.id),
  );

  return toDraft(row, lines, tags);
}

// ---------------------------------------------------------------------------
// Writing lines
// ---------------------------------------------------------------------------

/**
 * Turns wire lines into rows, resolving and checking every reference.
 *
 * The references are checked by *reading* them through `tenantDb` rather than by
 * letting the foreign keys refuse the insert. Both would refuse, and only this
 * one produces the right error: another org's account id arrives at the database
 * as errno 1452 and becomes a 500, where A7 requires the same 404 a nonexistent
 * id gets. The foreign keys stay as the backstop for the race between this read
 * and the insert.
 */
async function resolveLines(
  db: TenantDatabase,
  lines: readonly DraftLineInput[],
): Promise<readonly NewDraftLineRow[]> {
  const accountIds = collectIds(lines, (line) => line.accountId);
  const contactIds = collectIds(lines, (line) => line.contactId);
  const valueIds = lines.flatMap((line) =>
    (line.dimensionValueIds ?? []).map((value) => idBytes(value, 'dimension_value')),
  );

  const [accounts, contacts, axes] = await Promise.all([
    selectExistingAccountIds(db, accountIds),
    selectExistingContactIds(db, contactIds),
    selectDimensionAxes(db, valueIds),
  ]);

  assertAllPresent(accountIds, accounts, 'account');
  assertAllPresent(contactIds, contacts, 'contact');
  assertAllPresent(valueIds, new Set(axes.keys()), 'dimension_value');

  const issues: ValidationIssue[] = [];
  const rows = lines.map((line, index) => toDraftLineRow(line, index, axes, issues));

  if (issues.length > 0) throw new ValidationError('Draft line is not storable.', issues);

  return rows;
}

/**
 * One line, as the two amount columns hold it.
 *
 * Two states are refused rather than stored, and neither is incompleteness:
 *
 *  - **An amount with no side.** There is no column for it — the table records a
 *    side by which of `debit_minor` / `credit_minor` is non-zero — so storing it
 *    would mean dropping the number the user typed and saying nothing.
 *  - **A negative amount.** The side carries the sign (D-13), so a negative debit
 *    is a caller that has confused two models, and `chk_journal_draft_lines_non_negative`
 *    refuses it at the database regardless.
 *
 * A *side with no amount* is the opposite case and is stored: both columns hold
 * zero, and the line reads back with neither. That is an ordinary half-entered
 * line, which is what a draft is for.
 */
function toDraftLineRow(
  line: DraftLineInput,
  index: number,
  axes: ReadonlyMap<string, Buffer>,
  issues: ValidationIssue[],
): NewDraftLineRow {
  const path = `lines.${String(index)}`;
  const amount = line.amount === undefined || line.amount === null ? 0n : minorUnits(line.amount);

  if (amount > 0n && (line.side === undefined || line.side === null)) {
    issues.push({
      path: `${path}.side`,
      message:
        'An amount needs a side to sit on. Send `side` with it, or clear the amount — the ' +
        'table records a line’s side by which of its two amount columns is non-zero, so an ' +
        'amount with no side cannot be stored.',
    });
  }

  return {
    lineNumber: index + 1,
    accountId: optionalId(line.accountId, 'account'),
    contactId: optionalId(line.contactId, 'contact'),
    debitMinor: line.side === 'debit' ? amount : 0n,
    creditMinor: line.side === 'credit' ? amount : 0n,
    memo: line.memo ?? null,
    dimensions: resolveTags(line.dimensionValueIds ?? [], axes),
  };
}

/**
 * Resolves each value to its axis, refusing two values on one axis.
 *
 * `PRIMARY KEY (org_id, draft_line_id, dimension_id)` would refuse it too, as an
 * opaque duplicate-key error. Answering here instead is what makes it a
 * `precondition_failed` a client can act on, and it is the same answer the
 * dimensions service gives for a posted line — a draft that could hold two values
 * on one axis would produce a journal that cannot be tagged from it, and the
 * failure would surface at post rather than at entry.
 */
function resolveTags(
  valueIds: readonly string[],
  axes: ReadonlyMap<string, Buffer>,
): readonly { readonly dimensionId: Buffer; readonly valueId: Buffer }[] {
  const byAxis = new Map<string, { dimensionId: Buffer; valueId: Buffer }>();

  for (const value of valueIds) {
    const valueId = idBytes(value, 'dimension_value');
    const dimensionId = axes.get(valueId.toString('hex'));
    if (dimensionId === undefined) throw new NotFoundError('dimension_value');

    const axis = dimensionId.toString('hex');
    if (byAxis.has(axis)) throw duplicateAxisError();
    byAxis.set(axis, { dimensionId, valueId });
  }

  return [...byAxis.values()];
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

interface PostableLine {
  readonly id: bigint;
  readonly account_id: Buffer | null;
  readonly contact_id: Buffer | null;
  readonly debit_minor: bigint;
  readonly credit_minor: bigint;
  readonly memo: string | null;
}

/**
 * The draft, as `postJournal` takes it — or a `ValidationError` naming every
 * field that is not ready.
 *
 * Every issue is collected before any is thrown, so a user completing a draft
 * fixes it in one pass rather than one field per attempt. What is *not* checked
 * here is everything `postJournal` checks better: arity, balance, positivity,
 * whether the accounts and contacts exist and are active, and whether the tags
 * name live values of this org. The contact and the tags are passed through
 * unexamined for that reason — checking them here would be a second, drifting copy
 * of rules that belong to the ledger and to the dimensions module (OB-059).
 */
function toPostJournalInput(
  entryDate: string | null,
  memo: string | null,
  entryType: DraftEntryType,
  lines: readonly PostableLine[],
  tags: ReadonlyMap<string, readonly string[]>,
  ctx: RequestContext,
): PostJournalInput {
  const issues: ValidationIssue[] = [];

  if (entryDate === null) {
    issues.push({
      path: 'entryDate',
      message:
        'A draft needs an entry date before it can be posted. The date decides which fiscal ' +
        'period the entry lands in, and the period is resolved now rather than when the draft ' +
        'was written (ROADMAP D-19).',
    });
  }

  const postingLines: JournalLineInput[] = [];

  lines.forEach((line, index) => {
    const path = `lines.${String(index)}`;

    if (line.account_id === null) {
      issues.push({ path: `${path}.accountId`, message: 'This line has no account.' });
    }

    const isDebit = line.debit_minor > 0n;
    const isCredit = line.credit_minor > 0n;

    if (!isDebit && !isCredit) {
      issues.push({ path: `${path}.amount`, message: 'This line has no amount.' });
    } else if (isDebit && isCredit) {
      // Unreachable through this service, which writes one side or the other, and
      // reachable through the table, which has no `chk_journal_lines_one_sided`
      // counterpart on purpose. A draft edited by anything else must still fail
      // here rather than become a two-sided journal line.
      issues.push({
        path: `${path}.amount`,
        message: 'This line has an amount on both sides; a journal line moves one side only.',
      });
    } else if (line.account_id !== null) {
      const lineTags = tags.get(line.id.toString()) ?? [];

      postingLines.push({
        accountId: bufferToUuid(line.account_id),
        side: isDebit ? 'debit' : 'credit',
        amount: isDebit ? line.debit_minor : line.credit_minor,
        ...(line.memo === null ? {} : { memo: line.memo }),
        ...(line.contact_id === null ? {} : { contactId: bufferToUuid(line.contact_id) }),
        ...(lineTags.length === 0 ? {} : { dimensionValueIds: lineTags }),
      });
    }
  });

  if (issues.length > 0) {
    throw new ValidationError('This draft is not ready to post.', issues);
  }
  if (entryDate === null) {
    // Unreachable: a null date is the first issue collected above. Stated as a
    // fault rather than narrowed with `?? ''`, which would post an entry dated to
    // the empty string if the check above were ever removed.
    throw new InternalError('A draft with no entry date reached the posting call.');
  }

  return {
    date: entryDate,
    ...(memo === null ? {} : { memo }),
    // The draft's classification becomes the journal's `source` (P, OB-194/D-98):
    // `standard` leaves it to `postJournal`'s `'manual'` default; `adjusting` and
    // `reclassifying` mark the accountant's period-end corrections, which the audit
    // report and the general ledger then read off `source`.
    ...(entryType === 'standard' ? {} : { source: entryType }),
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    ...(ctx.invocationMode === undefined ? {} : { invocationMode: ctx.invocationMode }),
    lines: postingLines,
  };
}

// ---------------------------------------------------------------------------
// Small conversions
// ---------------------------------------------------------------------------

function collectIds(
  lines: readonly DraftLineInput[],
  of: (line: DraftLineInput) => string | null | undefined,
): readonly Buffer[] {
  const ids = new Map<string, Buffer>();

  for (const line of lines) {
    const value = of(line);
    if (value === null || value === undefined) continue;
    const bytes = tryUuidToBuffer(value);
    if (bytes !== undefined) ids.set(bytes.toString('hex'), bytes);
  }

  return [...ids.values()];
}

/**
 * A reference id as bytes.
 *
 * A malformed id is a miss rather than a validation failure, for the reason
 * `tryUuidToBuffer` gives: 400 for a malformed id and 404 for an unknown one is a
 * distinguishable answer for a class of ids, which is the shape A7 rules out.
 */
function idBytes(value: string, resource: string): Buffer {
  return assertFound(tryUuidToBuffer(value), resource);
}

function optionalId(value: string | null | undefined, resource: string): Buffer | null {
  return value === undefined || value === null ? null : idBytes(value, resource);
}

function assertAllPresent(
  ids: readonly Buffer[],
  present: ReadonlySet<string>,
  resource: string,
): void {
  if (ids.some((id) => !present.has(id.toString('hex')))) throw new NotFoundError(resource);
}

function minorUnits(value: string): bigint {
  // Through the money module rather than `BigInt(value)`: `fromMinorString` is the
  // authority on the wire format (D-13) and applies the storable-BIGINT bound, so
  // an over-large amount is a validation failure at the edge rather than a driver
  // error surfacing as a 500.
  return toMinorUnits(fromMinorString(value));
}

function requireAuthor(ctx: RequestContext): Buffer {
  const userId = ctx.userId === null ? undefined : tryUuidToBuffer(ctx.userId);
  if (userId === undefined) {
    // `journal_drafts.created_by_user_id` is NOT NULL and references `users`: a
    // draft is a person's unfinished work, so a context with no user has nothing
    // to author one. Automations and agents post directly — a draft they could
    // create is a draft nobody would ever open.
    throw new ValidationError('A draft is authored by a user.', [
      {
        path: 'actor',
        message:
          'This caller has no user identity, so it cannot create a draft. Post the journal ' +
          'directly instead.',
      },
    ]);
  }
  return userId;
}

function duplicateAxisError(): PreconditionFailedError {
  return new PreconditionFailedError(
    'duplicate_dimension_axis',
    'A line carries at most one value per dimension. Two of the values sent belong to the same ' +
      'axis, and picking one of them for you would silently change which slice of the business ' +
      'the amount is reported in.',
  );
}
