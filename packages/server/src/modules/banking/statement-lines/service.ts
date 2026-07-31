import type { BankStatementLine, BankStatementLinePage } from '@openbooks/shared-types';
import {
  createManualStatementLineRequestSchema,
  listBankStatementLinesQuerySchema,
} from '@openbooks/shared-types';
import type { ListBankStatementLinesQuery } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { getContext } from '../../../context';
import { newUuidBuffer, resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { InternalError, assertFound, parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';

import { BANK_ACCOUNT_RESOURCE } from '../bank-accounts/bank-accounts.repository';
import { selectEntriesForClearing } from '../clearing/clearing.repository';
import { computeFingerprint } from '../statements/fingerprint';
import {
  existingFingerprintCounts,
  insertLinesIgnore,
  selectBankAccount,
} from '../statements/repository';

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
 * The one write here is `createManualStatementLine`, and it does not break D-42: a
 * hand-entered line is still a bank fact, transcribed by a person before the file that
 * carries it has arrived (a same-day deposit, a fee). It is written exactly once, never
 * modified, and computes its `fingerprint`/`occurrence_index` the way an import does — so
 * when the file finally lands, the import recognises it as already present and does not
 * double it. What the pipeline *decides* still lives only in rows that reference a line.
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

/**
 * Enter one statement line by hand, for the match/reconcile flow when a transaction the
 * bank shows has no file yet (a same-day deposit, a fee). Reuses `banking.import` — it is
 * the one write that produces a `bank_statement_lines` row either way.
 *
 * The `fingerprint` and `occurrence_index` are computed exactly as an import computes them,
 * so this line and a later import of the same transaction collapse to one (D-42). `import_id`
 * is NULL: there is no file. The line cannot be locked — it is append-only, so `FOR UPDATE`
 * is ungranted — so the occurrence index is assigned optimistically against the unique key
 * and re-tried if a concurrent identical entry claimed it first. A double-submit is not this
 * loop's concern: the universal Idempotency-Key dedupes it a layer up.
 */
export async function createManualStatementLine(
  input: unknown,
  ctx: RequestContext = getContext('createManualStatementLine()'),
): Promise<BankStatementLine> {
  await requirePermission(ctx, 'banking.import');
  const request = parseInput(createManualStatementLineRequestSchema, input);

  const db = orgScope(ctx);
  const bankAccountId = assertFound(tryUuidToBuffer(request.bankAccountId), BANK_ACCOUNT_RESOURCE);
  assertFound(await selectBankAccount(db, bankAccountId), BANK_ACCOUNT_RESOURCE);

  const amountMinor = BigInt(request.amount);
  const fingerprint = computeFingerprint({
    postedDate: request.postedDate,
    amount: amountMinor,
    description: request.description,
    bankReference: request.bankReference,
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const counts = await existingFingerprintCounts(db, bankAccountId, [fingerprint]);
    const occurrenceIndex = counts.get(fingerprint) ?? 0;
    const id = newUuidBuffer();

    await insertLinesIgnore(db, [
      {
        id,
        bankAccountId,
        importId: null,
        postedDate: request.postedDate,
        valueDate: request.valueDate,
        description: request.description,
        counterparty: request.counterparty,
        amountMinor,
        bankReference: request.bankReference,
        fingerprint,
        occurrenceIndex,
      },
    ]);

    // INSERT IGNORE drops the row when that (fingerprint, occurrence_index) already exists,
    // so read back by the id this call minted: present means this call is the one that
    // created it; absent means a concurrent identical entry took the index — recount, retry.
    const row = await selectStatementLineById(db, id);
    if (row !== undefined) return toStatementLine(row, null);
  }

  throw new InternalError('Could not assign an occurrence index for the statement line.');
}
