import type { PayoutReportingCategory } from '@openbooks/shared-types';

import type { TenantDatabase } from '../../db';
import { bufferToUuid, newUuidBuffer } from '../../db';

/**
 * Data access for `payout_account_map` (OB-237, D-237-6; migration `0024_payout_sync`)
 * — the per-connection `reporting_category → account_id` mapping a payout's summary
 * journal is built from.
 *
 * Everything goes through `tenantDb`, so `org_id = ctx.orgId` is on every statement
 * before this file adds a predicate — a cross-connection or cross-org id matches
 * nothing here, exactly as `connections.repository.ts`'s header explains for its own
 * table.
 *
 * `replaceAccountMap` is the only writer, and it replaces the set wholesale rather
 * than patching a row at a time — the screen always sends the complete mapping it is
 * showing, the same shape `rules.repository.ts`'s `deleteRuleDimensions` +
 * `insertRuleDimensions` pair gives `bank_rule_dimensions`. This file does not
 * resolve or validate the `account_id`s it is given; that belongs to the service
 * (`selectAccountActive`'s pre-check in `connections.repository.ts` is the sibling
 * example), so a caller here has already decided the mapping is legal.
 */

export interface AccountMapEntryRow {
  readonly reportingCategory: PayoutReportingCategory;
  readonly accountId: Buffer;
}

export interface NewAccountMapEntry {
  readonly reportingCategory: PayoutReportingCategory;
  readonly accountId: Buffer;
}

export async function selectAccountMap(
  db: TenantDatabase,
  connectionId: Buffer,
): Promise<readonly AccountMapEntryRow[]> {
  const rows = await db
    .selectFrom('payout_account_map')
    .select(['reporting_category', 'account_id'])
    .where('connection_id', '=', connectionId)
    .execute();

  return rows.map((row) => ({
    reportingCategory: row.reporting_category as PayoutReportingCategory,
    accountId: row.account_id,
  }));
}

/**
 * The same rows as a `category → account uuid` map — the shape the summary-journal
 * builder consumes (a lookup by category, not a list).
 */
export async function selectAccountMapAsUuidMap(
  db: TenantDatabase,
  connectionId: Buffer,
): Promise<ReadonlyMap<PayoutReportingCategory, string>> {
  const rows = await selectAccountMap(db, connectionId);
  return new Map(rows.map((row) => [row.reportingCategory, bufferToUuid(row.accountId)]));
}

/**
 * Replaces a connection's entire category→account mapping. The caller wraps this in
 * a transaction (`transaction-scope.ts`'s ambient join); this issues the delete then
 * the insert like any other multi-statement repository helper, not the other way
 * around, matching `rules.repository.ts`'s tag-replace pair.
 */
export async function replaceAccountMap(
  db: TenantDatabase,
  params: {
    readonly connectionId: Buffer;
    readonly createdByUserId: Buffer;
    readonly entries: readonly NewAccountMapEntry[];
  },
): Promise<void> {
  await db
    .deleteFrom('payout_account_map')
    .where('connection_id', '=', params.connectionId)
    .execute();

  if (params.entries.length === 0) return;

  await db
    .insertInto('payout_account_map')
    .values(
      params.entries.map((entry) => ({
        id: newUuidBuffer(),
        connection_id: params.connectionId,
        reporting_category: entry.reportingCategory,
        account_id: entry.accountId,
        created_by_user_id: params.createdByUserId,
      })),
    )
    .execute();
}
