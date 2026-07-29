import type { BankStatementLine, BankStatementLinePage } from '@openbooks/shared-types';
import { listBankStatementLinesQuerySchema } from '@openbooks/shared-types';
import type { ListBankStatementLinesQuery } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { getContext } from '../../../context';
import { resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { assertFound, parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';

import { selectEntriesForClearing } from '../clearing/clearing.repository';

import type { StatementLineFilters } from './repository';
import {
  STATEMENT_LINE_RESOURCE as RESOURCE,
  lineIdBytes,
  orgScope,
  selectClearingByLine,
  selectClearingEntriesForClearings,
  selectClearingsForLines,
  selectStatementLineById,
  selectStatementLinesPage,
  toBankLineClearing,
  toStatementLine,
} from './repository';

/**
 * Statement-line reads (OB-084; ROADMAP D-42, D-45).
 *
 * The list the matching and reconciliation screens (OB-086) work from, plus a single
 * fetch so a client can re-read a line after clearing it — the clear endpoint returns
 * the clearing, not the whole line. Both are `banking.read`, the permission the
 * proposal engine and the reconciliation report already take.
 *
 * There is no write here and there never will be: a statement line is what the bank
 * said (D-42), and everything the pipeline decides lives in rows that *reference* a
 * line — a proposal, a clearing — never in the line itself.
 */

export async function getStatementLine(
  lineId: string,
  ctx: RequestContext = getContext('getStatementLine()'),
): Promise<BankStatementLine> {
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  const id = assertFound(lineIdBytes(lineId), RESOURCE);
  const line = assertFound(await selectStatementLineById(db, id), RESOURCE);

  const clearing = await selectClearingByLine(db, id);
  if (clearing === undefined) return toStatementLine(line, null);

  const entries = await selectEntriesForClearing(db, clearing.id);
  return toStatementLine(line, toBankLineClearing(clearing, entries));
}

/**
 * One page of a bank account's statement lines, in `(posted_date, id)` order.
 *
 * `cleared` is the matching screen's whole filter — the lines with nothing against them
 * are the work. A malformed `bankAccountId` or `importId` filters to nothing rather than
 * 404ing, matching `listBankRules`: an id that resolves to nothing is what an unknown
 * one does, and an empty page keeps a filter's failure mode uniform (E9).
 */
export async function listStatementLines(
  query: ListBankStatementLinesQuery,
  ctx: RequestContext = getContext('listStatementLines()'),
): Promise<BankStatementLinePage> {
  await requirePermission(ctx, 'banking.read');
  const filters = parseInput(listBankStatementLinesQuerySchema, query);

  const bankAccountId =
    filters.bankAccountId === undefined ? undefined : tryUuidToBuffer(filters.bankAccountId);
  if (filters.bankAccountId !== undefined && bankAccountId === undefined) {
    return { items: [], nextCursor: null };
  }
  const importId = filters.importId === undefined ? undefined : tryUuidToBuffer(filters.importId);
  if (filters.importId !== undefined && importId === undefined) {
    return { items: [], nextCursor: null };
  }

  const lineFilters: StatementLineFilters = {
    ...(bankAccountId === undefined ? {} : { bankAccountId }),
    ...(importId === undefined ? {} : { importId }),
    ...(filters.direction === undefined ? {} : { direction: filters.direction }),
    ...(filters.cleared === undefined ? {} : { cleared: filters.cleared }),
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
  };

  const db = orgScope(ctx);
  const limit = resolvePageLimit(filters.limit);
  const page = await selectStatementLinesPage(db, lineFilters, limit);

  const clearings = await selectClearingsForLines(
    db,
    page.rows.map((row) => row.id),
  );
  const entriesByClearing = await selectClearingEntriesForClearings(
    db,
    [...clearings.values()].map((clearing) => clearing.id),
  );

  const items = page.rows.map((row) => {
    const clearing = clearings.get(row.id.toString('hex'));
    if (clearing === undefined) return toStatementLine(row, null);
    const entries = entriesByClearing.get(clearing.id.toString('hex')) ?? [];
    return toStatementLine(row, toBankLineClearing(clearing, entries));
  });

  return { items, nextCursor: page.nextCursor };
}
