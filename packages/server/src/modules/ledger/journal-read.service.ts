import type { PostedJournal, PostedJournalLine } from '@openbooks/plugin-api';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, orgScope, tenantDb, tryUuidToBuffer } from '../../db';
import { assertFound } from '../../errors';
import { requirePermission } from '../permissions';

import { selectJournalById } from './posting.repository';

/**
 * Reading one posted journal, with its lines (OB-236; spec §7).
 *
 * The standalone counterpart to `postJournal`/`reverseJournal`'s in-transaction
 * `readBack` (`posting.service.ts`): same `PostedJournal` shape, reached by id
 * instead of by just having posted it. Separate from `posting.service.ts` for the
 * reason `index.ts` gives about `listJournals` and the trial balance — a caller
 * that only needs to read one journal never holds a handle that can post or
 * reverse it.
 *
 * `requirePermission` runs first, before the id is parsed, so an unauthorized
 * caller learns nothing about the shape of an API they cannot use. Malformed,
 * another org's, and nonexistent ids then all reach the same `assertFound` and so
 * answer identically (A7) — the same handling `reverseJournal` gives
 * `input.journalId`.
 */
export async function getJournal(
  journalId: string,
  ctx: RequestContext = getContext('getJournal()'),
): Promise<PostedJournal> {
  await requirePermission(ctx, 'journals.read');

  const orgId = orgScope(ctx.orgId);
  const targetId = tryUuidToBuffer(journalId);

  const journal = assertFound(
    targetId ? await selectJournalById(tenantDb(orgId), targetId) : undefined,
    'journal',
  );

  const lines: PostedJournalLine[] = journal.lines.map((line) => ({
    lineId: line.id.toString(),
    accountId: bufferToUuid(line.accountId),
    side: line.debitMinor > 0n ? 'debit' : 'credit',
    amount: line.debitMinor > 0n ? line.debitMinor : line.creditMinor,
    memo: line.memo,
    contactId: line.contactId === null ? null : bufferToUuid(line.contactId),
    dimensionValueIds: line.dimensionValueIds.map((value) => bufferToUuid(value)),
  }));

  return {
    journalId: bufferToUuid(journal.id),
    orgId: bufferToUuid(orgId),
    date: journal.entryDate,
    memo: journal.memo,
    postedAt: journal.createdAt.toISOString(),
    actorType: journal.actorType,
    actorId: bufferToUuid(journal.actorId),
    invocationMode: journal.invocationMode,
    reversesJournalId: journal.reversesJournalId ? bufferToUuid(journal.reversesJournalId) : null,
    lines,
  };
}
