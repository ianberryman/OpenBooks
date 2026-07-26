import type { Kysely } from 'kysely';

import type { DB } from '../../db';
import { bufferToUuid, systemDb, TenantDatabase, tryUuidToBuffer } from '../../db';

/**
 * Reads and writes for orgs and their membership list.
 *
 * ## Why an executor is a parameter on the writes and not on the reads
 *
 * Registration creates a user, an org, and a membership, and spec §5 makes all
 * three one fact: an org with no members is unreachable (every read of it goes
 * through `org_members`) and a user with no membership cannot do anything. So they
 * commit together or not at all, which means the org write has to be able to run
 * on a transaction opened by the caller.
 *
 * That transaction can only come from `systemDb()`. `tenantDb(orgId).transaction()`
 * propagates ambiently (`src/db/transaction-scope.ts`) but `systemDb()` does not
 * consult that scope — it returns the pool handle unconditionally — and `users` and
 * `orgs` are not tenant tables, so a transaction opened through the tenant wrapper
 * would not enclose them. Flagged in the OB-015 report; until it changes, the
 * caller opens the transaction on `systemDb()` and hands it down.
 *
 * Reads take no executor because none of them needs to see uncommitted state.
 */
type SystemExecutor = Kysely<DB>;

/** mysql2's `errno` for a unique constraint violation (`ER_DUP_ENTRY`). */
const DUPLICATE_ENTRY_ERRNO = 1062;

export function isDuplicateEntryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { errno?: unknown }).errno === DUPLICATE_ENTRY_ERRNO
  );
}

export interface OrgRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly fiscalYearStartMonth: number;
}

export interface NewOrgRow {
  readonly id: Buffer;
  readonly name: string;
  readonly slug: string;
  readonly fiscalYearStartMonth: number;
}

export async function insertOrg(executor: SystemExecutor, row: NewOrgRow): Promise<void> {
  await executor
    .insertInto('orgs')
    .values({
      id: row.id,
      name: row.name,
      slug: row.slug,
      fiscal_year_start_month: row.fiscalYearStartMonth,
    })
    .execute();
}

/**
 * Seeds the first membership of a brand-new org.
 *
 * Goes through `TenantDatabase` rather than `executor.insertInto('org_members')`
 * even though the two produce the same row here, because `org_members` is a tenant
 * table and the wrapper is what makes `org_id` un-passable (OB-013). Writing the
 * insert by hand would put a second, unscoped writer on a tenant table into the
 * codebase for the sake of saving one line.
 *
 * The wrapper is constructed rather than obtained from `tenantDb()` because it has
 * to sit on the caller's transaction — see the note at the top of this file.
 */
export async function insertMembership(
  executor: SystemExecutor,
  orgId: Buffer,
  userId: Buffer,
  roleId: Buffer,
): Promise<void> {
  await new TenantDatabase(executor, orgId)
    .insertInto('org_members')
    .values({ user_id: userId, role_id: roleId })
    .execute();
}

export async function selectOrg(orgId: string): Promise<OrgRow | undefined> {
  const key = tryUuidToBuffer(orgId);
  if (key === undefined) return undefined;

  const row = await systemDb()
    .selectFrom('orgs')
    .select(['id', 'name', 'slug', 'fiscal_year_start_month'])
    .where('id', '=', key)
    .executeTakeFirst();

  return row === undefined ? undefined : toOrgRow(row);
}

/**
 * Every org the user is a member of, ordered so the list is stable across calls.
 *
 * Deliberately does not join `roles`. The role a membership carries is only
 * resolvable through the `roles.org_id = ? OR roles.org_id IS NULL` predicate that
 * `src/modules/permissions/permissions.repository.ts` owns, and a second copy of a
 * predicate whose omission silently turns a role id into a cross-tenant capability
 * is not worth the round trip it saves. The service maps each row through
 * `resolveMembership` instead.
 */
export async function selectMemberOrgs(userId: string): Promise<readonly OrgRow[]> {
  const key = tryUuidToBuffer(userId);
  if (key === undefined) return [];

  const rows = await systemDb()
    .selectFrom('org_members as m')
    .innerJoin('orgs as o', 'o.id', 'm.org_id')
    .select(['o.id', 'o.name', 'o.slug', 'o.fiscal_year_start_month', 'm.created_at'])
    .where('m.user_id', '=', key)
    .orderBy('m.created_at', 'asc')
    .orderBy('o.name', 'asc')
    .orderBy('o.id', 'asc')
    .execute();

  return rows.map(toOrgRow);
}

/**
 * The org a login lands in when the session names none, or names one the user is no
 * longer a member of.
 *
 * Total ordering, including a tiebreak on `id`: two concurrent requests on the same
 * session must agree on the scope they run in, and `created_at` is `DATETIME(3)`, so
 * two memberships created in the same millisecond are not merely possible but are
 * the normal case for registration.
 */
export async function selectDefaultMemberOrgId(userId: string): Promise<string | undefined> {
  const [first] = await selectMemberOrgs(userId);
  return first?.id;
}

function toOrgRow(row: {
  readonly id: Buffer;
  readonly name: string;
  readonly slug: string;
  readonly fiscal_year_start_month: number;
}): OrgRow {
  return {
    id: bufferToUuid(row.id),
    name: row.name,
    slug: row.slug,
    fiscalYearStartMonth: row.fiscal_year_start_month,
  };
}
