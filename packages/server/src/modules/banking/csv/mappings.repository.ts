import type { BankImportMapping, BankImportMappingDefinition } from '@openbooks/shared-types';
import { BANKING_RESOURCES } from '@openbooks/shared-types';

import type { RequestContext } from '../../../context';
import type { KeysetOrdering, KeysetPage, TenantDatabase } from '../../../db';
import {
  applyKeyset,
  bufferToUuid,
  instantKey,
  isDuplicateEntryError,
  newUuidBuffer,
  orgScope as toOrgId,
  tenantDb,
  toKeysetPage,
  tryUuidToBuffer,
  uuidKey,
} from '../../../db';
import { ConflictError, InternalError } from '../../../errors';

/**
 * Data access for bank import mappings (OB-076).
 *
 * Everything here goes through `tenantDb`, so `bank_import_mappings.org_id = ?` is
 * on every statement before this file adds a predicate — which is what makes a
 * cross-org id a miss rather than a leak (E9/A7), with `assertFound` in the service
 * turning the miss into the one error it is allowed to produce.
 *
 * The other job of this file is that the one client-facing driver error does not
 * escape it: a duplicate name for the same account is `uq_bank_import_mappings_account_name`
 * (errno 1062), the caller's situation rather than a fault, and it becomes a
 * `ConflictError` here instead of reaching the transport as an opaque 500.
 */

/** The resource tokens every miss in this module reports (E9). */
export const BANK_IMPORT_MAPPING_RESOURCE = BANKING_RESOURCES.BANK_IMPORT_MAPPING;
export const BANK_ACCOUNT_RESOURCE = BANKING_RESOURCES.BANK_ACCOUNT;

const MAPPING_COLUMNS = [
  'id',
  'bank_account_id',
  'name',
  'has_header_row',
  'delimiter',
  'date_order',
  'amount_convention',
  'posted_date_column',
  'description_column',
  'amount_column',
  'debit_column',
  'credit_column',
  'value_date_column',
  'counterparty_column',
  'bank_reference_column',
  'created_at',
  'updated_at',
] as const;

interface MappingRow {
  readonly id: Buffer;
  readonly bank_account_id: Buffer;
  readonly name: string;
  readonly has_header_row: number;
  readonly delimiter: string;
  readonly date_order: 'ymd' | 'dmy' | 'mdy';
  readonly amount_convention: 'signed' | 'signed_reversed' | 'debit_credit_columns';
  readonly posted_date_column: number;
  readonly description_column: number;
  readonly amount_column: number | null;
  readonly debit_column: number | null;
  readonly credit_column: number | null;
  readonly value_date_column: number | null;
  readonly counterparty_column: number | null;
  readonly bank_reference_column: number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export function orgScope(ctx: RequestContext): TenantDatabase {
  return tenantDb(toOrgId(ctx.orgId));
}

/**
 * A client-supplied mapping id as bytes, or `undefined` when it is not a UUID.
 *
 * Undefined rather than a throw, so the service routes a malformed id through
 * `assertFound` to the same 404 a nonexistent one produces. A 400 here would be a
 * distinguishable answer for a class of ids, which is the shape E9/A7 rules out.
 */
export function mappingIdBytes(mappingId: string): Buffer | undefined {
  return tryUuidToBuffer(mappingId);
}

/**
 * The bank account's id if it exists in this org, else `undefined`.
 *
 * A mapping references a bank account, and the service checks it exists before the
 * insert so an unknown or cross-org account is a 404 (E9) rather than the foreign
 * key surfacing errno 1452 as an opaque 500. Org-scoped, so another org's account
 * is indistinguishable from a missing one.
 */
export async function selectBankAccount(
  db: TenantDatabase,
  id: Buffer,
): Promise<{ readonly id: Buffer } | undefined> {
  return db.selectFrom('bank_accounts').select('id').where('id', '=', id).executeTakeFirst();
}

export async function insertMapping(
  db: TenantDatabase,
  bankAccountId: Buffer,
  name: string,
  definition: BankImportMappingDefinition,
): Promise<MappingRow> {
  const id = newUuidBuffer();
  const columns = definition.columns;

  try {
    await db
      .insertInto('bank_import_mappings')
      .values({
        id,
        bank_account_id: bankAccountId,
        name,
        has_header_row: definition.hasHeaderRow ? 1 : 0,
        delimiter: definition.delimiter,
        date_order: definition.dateOrder,
        amount_convention: definition.amountConvention,
        posted_date_column: columns.postedDate,
        description_column: columns.description,
        amount_column: columns.amount,
        debit_column: columns.debit,
        credit_column: columns.credit,
        value_date_column: columns.valueDate,
        counterparty_column: columns.counterparty,
        bank_reference_column: columns.bankReference,
      })
      .execute();
  } catch (error) {
    throw translateDuplicateName(error, name);
  }

  const row = await selectMappingById(db, id);
  if (row === undefined) {
    throw new InternalError(
      'The bank import mapping inserted by this statement could not be read back.',
    );
  }
  return row;
}

export async function selectMappingById(
  db: TenantDatabase,
  id: Buffer,
): Promise<MappingRow | undefined> {
  return db
    .selectFrom('bank_import_mappings')
    .select(MAPPING_COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
}

/**
 * The most-recently-used mapping for an account, or `undefined` when it has none.
 *
 * This is what OB-076 offers in place of a default mapping on the account, and it
 * is a single bounded read served by `idx_bank_import_mappings_org_account`
 * (`org_id, bank_account_id, updated_at`): "most recently touched first" is
 * `updated_at DESC`, which MySQL drives from that index by scanning it backwards.
 * `id DESC` breaks a tie so the answer is deterministic when two mappings share a
 * millisecond. A mapping is "used" when the import that read a file through it
 * touches its `updated_at` (OB-078); until then this is simply the newest.
 */
export async function selectMostRecentlyUsed(
  db: TenantDatabase,
  bankAccountId: Buffer,
): Promise<MappingRow | undefined> {
  return db
    .selectFrom('bank_import_mappings')
    .select(MAPPING_COLUMNS)
    .where('bank_account_id', '=', bankAccountId)
    .orderBy('updated_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
}

/**
 * `(created_at, id)` — the general ordering D-21 names, and the one this list has to
 * use rather than merely may.
 *
 * Not `updated_at`, even though the most-recently-used *read* orders by it: a keyset
 * cursor's columns must be immutable (D-21), and `updated_at` moves every time a
 * mapping is touched, so a mapping edited mid-page would slip behind a cursor that
 * had already passed it and vanish from the list. `created_at` is written once. The
 * most-recently-used pick is a single row and needs no cursor, so it is free to use
 * the mutable column the list cannot.
 *
 * There is no `(org_id, bank_account_id, created_at)` index, so a page is a filesort
 * today — recorded rather than worked around, exactly as `payments.repository`
 * records the same trade: choosing a keyset to suit the indexes that exist would
 * trade a correct list for a fast one, and the mappings on one account are few.
 */
const MAPPING_KEYSET: KeysetOrdering<MappingRow> = [
  instantKey('bank_import_mappings.created_at', (row) => row.created_at),
  uuidKey('bank_import_mappings.id', (row) => row.id),
];

export async function selectMappingsPage(
  db: TenantDatabase,
  bankAccountId: Buffer,
  cursor: string | undefined,
  limit: number,
): Promise<KeysetPage<MappingRow>> {
  const query = db
    .selectFrom('bank_import_mappings')
    .select(MAPPING_COLUMNS)
    .where('bank_account_id', '=', bankAccountId);

  const rows = await applyKeyset(query, MAPPING_KEYSET, limit, cursor).execute();
  return toKeysetPage(rows, MAPPING_KEYSET, limit);
}

export function toBankImportMapping(row: MappingRow): BankImportMapping {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    definition: {
      hasHeaderRow: row.has_header_row !== 0,
      delimiter: row.delimiter,
      dateOrder: row.date_order,
      amountConvention: row.amount_convention,
      columns: {
        postedDate: row.posted_date_column,
        description: row.description_column,
        amount: row.amount_column,
        debit: row.debit_column,
        credit: row.credit_column,
        valueDate: row.value_date_column,
        counterparty: row.counterparty_column,
        bankReference: row.bank_reference_column,
      },
    },
    // `timezone: 'Z'` on the pool and `DATETIME(3)` left as a `Date`
    // (`src/db/connection.ts`), so these are lossless renderings of real instants.
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * `uq_bank_import_mappings_account_name` as a `ConflictError`.
 *
 * Free text is permitted on a conflict, unlike on a 404: the unique key is
 * `(org_id, bank_account_id, name)`, so the row this collides with is inside the
 * caller's own org and naming it discloses nothing they cannot already read. Any
 * other driver error is rethrown untouched and becomes an opaque 500, which is
 * correct — this function knows about exactly one constraint and must not guess.
 */
function translateDuplicateName(error: unknown, name: string): unknown {
  if (!isDuplicateEntryError(error)) return error;

  return new ConflictError(
    `A bank import mapping named ${JSON.stringify(name)} already exists for this bank account. ` +
      'Names are unique per account; rename it, or update the existing mapping.',
    { name },
  );
}
