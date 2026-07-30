import type { TenantDatabase } from '../../db';
import { systemDb } from '../../db';

/**
 * Data access for `statement_packages` (initiative P, OB-195; `0017_accountant_close`).
 *
 * Append-only, the same shape as `invoice_deliveries` (`delivery.repository.ts`):
 * a re-render is a new row and the artifact it names was frozen at render time, so
 * there is no update path here — only an insert and two reads.
 */

export interface StatementPackageRow {
  readonly id: Buffer;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly basis: 'accrual' | 'cash';
  readonly artifactStorageKey: string;
  readonly generatedByUserId: Buffer;
  readonly createdAt: Date;
}

export interface NewStatementPackageRow {
  readonly id: Buffer;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly basis: 'accrual' | 'cash';
  readonly artifactStorageKey: string;
  readonly generatedByUserId: Buffer;
}

/**
 * Writes the row and reads `created_at` back — MySQL has no `RETURNING`, and the
 * wire contract needs the server-set default's exact value, not the app's guess at
 * what it resolved to (`delivery.repository.ts#insertDelivery`'s own reason).
 */
export async function insertStatementPackage(
  db: TenantDatabase,
  row: NewStatementPackageRow,
): Promise<StatementPackageRow> {
  await db
    .insertInto('statement_packages')
    .values({
      // `org_id` is injected by `tenantDb`.
      id: row.id,
      period_start: row.periodStart,
      period_end: row.periodEnd,
      basis: row.basis,
      artifact_storage_key: row.artifactStorageKey,
      generated_by_user_id: row.generatedByUserId,
    })
    .execute();

  const persisted = await db
    .selectFrom('statement_packages')
    .select('created_at')
    .where('id', '=', row.id)
    .executeTakeFirstOrThrow();

  return { ...row, createdAt: persisted.created_at };
}

/**
 * Every package this org has rendered, newest first. Unpaginated (the wire
 * contract's own convention, `statementPackageListSchema`'s doc comment) — a v1
 * accountant renders a handful of these a year, not enough to justify a keyset.
 *
 * Ordered by `created_at` then `id`, both descending: two packages rendered inside
 * the same millisecond — plausible in a test, and not ruled out in production by
 * `DATETIME(3)`'s precision — would otherwise have no defined order between them.
 */
export async function listStatementPackages(db: TenantDatabase): Promise<StatementPackageRow[]> {
  const rows = await db
    .selectFrom('statement_packages')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    basis: row.basis,
    artifactStorageKey: row.artifact_storage_key,
    generatedByUserId: row.generated_by_user_id,
    createdAt: row.created_at,
  }));
}

/**
 * Display names for a batch of authors, keyed by their `BINARY(16)` user id.
 *
 * `users` is not a tenant table (a user exists across orgs), so this reaches it
 * through `systemDb` rather than `tenantDb` — the same split `members.repository.ts#selectUser`
 * takes for a single user, batched here because a package list can name several
 * distinct authors and one `IN` query beats one round trip per row. A user id with
 * no match (a user deleted despite `fk_sp_author`'s `ON DELETE RESTRICT`, or one
 * that predates a schema change) resolves to `undefined`, and the service maps
 * that to the wire contract's documented `null`.
 */
export async function selectUserDisplayNames(
  userIds: readonly Buffer[],
): Promise<ReadonlyMap<string, string>> {
  if (userIds.length === 0) return new Map();

  const rows = await systemDb()
    .selectFrom('users')
    .select(['id', 'display_name'])
    .where('id', 'in', [...userIds])
    .execute();

  return new Map(rows.map((row) => [row.id.toString('hex'), row.display_name]));
}
