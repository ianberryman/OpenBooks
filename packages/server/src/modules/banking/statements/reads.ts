import type { BankStatementImport, BankStatementImportPage } from '@openbooks/shared-types';
import { listBankStatementImportsQuerySchema } from '@openbooks/shared-types';
import type { ListBankStatementImportsQuery } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import { getContext } from '../../../context';
import { bufferToUuid, resolvePageLimit, tryUuidToBuffer } from '../../../db';
import { assertFound, parseInput } from '../../../errors';
import { requirePermission } from '../../permissions';

import type { ImportListFilters, ImportReadRow } from './repository';
import {
  STATEMENT_IMPORT_RESOURCE as RESOURCE,
  orgScope,
  selectImportForRead,
  selectImportsPage,
} from './repository';

/**
 * The import-poll reads (OB-084's follow-up; ROADMAP D-47, D-49; acceptance E1).
 *
 * `startImport` returns a queued handle and the parse runs on the worker, so a screen
 * needs a way to poll the import from `queued` through `processing` to `complete`/
 * `failed`. These are that surface — `banking.read`, thin, `tenantDb`, `assertFound` →
 * 404 (E9). There is no write here: an import's lifecycle is the worker's to advance.
 *
 * `result` is present exactly when `complete` and `failureReason` exactly when `failed`,
 * which is the `0006_banking` CHECK — the mapper reads it off `status` rather than off
 * the nullable columns, so the wire shape cannot contradict the state.
 */

function toBankStatementImport(row: ImportReadRow): BankStatementImport {
  const result =
    row.status === 'complete' && row.lines_read !== null && row.lines_duplicate !== null
      ? {
          linesRead: row.lines_read,
          linesImported: row.lines_read - row.lines_duplicate,
          linesDuplicate: row.lines_duplicate,
        }
      : null;

  return {
    id: bufferToUuid(row.id),
    bankAccountId: bufferToUuid(row.bank_account_id),
    format: row.format,
    filename: row.filename,
    mappingId: row.mapping_id === null ? null : bufferToUuid(row.mapping_id),
    status: row.status,
    result,
    failureReason: row.status === 'failed' ? row.failure_reason : null,
    statementClosingBalance:
      row.closing_balance_minor === null ? null : row.closing_balance_minor.toString(),
    externalAccountId: row.external_account_id,
    importedByUserId: bufferToUuid(row.imported_by_user_id),
    createdAt: row.created_at.toISOString(),
  };
}

export async function getBankStatementImport(
  importId: string,
  ctx: RequestContext = getContext('getBankStatementImport()'),
): Promise<BankStatementImport> {
  await requirePermission(ctx, 'banking.read');

  const db = orgScope(ctx);
  const id = assertFound(tryUuidToBuffer(importId), RESOURCE);
  return toBankStatementImport(assertFound(await selectImportForRead(db, id), RESOURCE));
}

/**
 * One page of a bank account's imports, newest activity last by creation (D-21).
 *
 * A malformed or cross-org `bankAccountId` filters to an empty page rather than 404ing,
 * matching `listBankImportMappings`: a filter that matches nothing is what an unknown
 * one does, and an empty page keeps a filter's failure mode uniform (E9).
 */
export async function listBankStatementImports(
  query: ListBankStatementImportsQuery,
  ctx: RequestContext = getContext('listBankStatementImports()'),
): Promise<BankStatementImportPage> {
  await requirePermission(ctx, 'banking.read');
  const filters = parseInput(listBankStatementImportsQuerySchema, query);

  const bankAccountId =
    filters.bankAccountId === undefined ? undefined : tryUuidToBuffer(filters.bankAccountId);
  if (filters.bankAccountId !== undefined && bankAccountId === undefined) {
    return { items: [], nextCursor: null };
  }

  const listFilters: ImportListFilters = {
    ...(bankAccountId === undefined ? {} : { bankAccountId }),
    ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
  };

  const limit = resolvePageLimit(filters.limit);
  const page = await selectImportsPage(orgScope(ctx), listFilters, limit);

  return { items: page.rows.map(toBankStatementImport), nextCursor: page.nextCursor };
}
