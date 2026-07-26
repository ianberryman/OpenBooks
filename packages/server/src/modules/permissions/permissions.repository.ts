import type { AliasedRawBuilder, Expression, SqlBool } from 'kysely';
import { sql } from 'kysely';

import { systemDb } from '../../db';
import type { PermissionKey } from './catalog';
import { isPermissionKey } from './catalog';

/**
 * Reads for role → permission resolution.
 *
 * ## Why `systemDb()` and not `tenantDb()`
 *
 * `roles` is the one table deliberately excluded from `TenantTableName`
 * (`src/db/tenant-tables.ts`). Its `org_id` is **nullable**, and NULL means "system
 * role, shared by every org" — which is what all six seeded roles are. The tenant
 * wrapper injects a bare `org_id = ?`, and MySQL's `NULL = x` is NULL, never true,
 * so a scoped query against `roles` returns zero rows for every seeded role. The
 * symptom is not an error: it is every user in the system silently holding no
 * permissions at all, on every request, which fails closed loudly enough to notice
 * in a test suite and quietly enough to ship if nobody wrote one.
 *
 * So the predicate is written by hand, once, here:
 *
 * ```sql
 * (roles.org_id = <org> OR roles.org_id IS NULL)
 * ```
 *
 * The `IS NULL` half admits the shared system roles. The `= <org>` half is not
 * decoration: it is what stops a *custom* role belonging to another org (spec §5
 * reserves non-null `org_id` for the v2 role editor) from resolving under this
 * org's context. Dropping it would turn a role id into a cross-tenant capability.
 *
 * ## Why ids are handed to MySQL as UUID strings
 *
 * `OperationContext` carries ids as UUID strings; the schema stores `BINARY(16)`
 * in plain hex byte order (`UUID_TO_BIN(x, 0)`, spec §4). The only conversion in
 * the tree lives in `test/db/uuid.ts`, whose own commentary is the reason a second
 * copy is not written here: a swapped encoding still produces sixteen valid bytes,
 * still inserts, still round-trips through the copy that produced it, and only
 * disagrees with the database — surfacing as a row that cannot be found by the id
 * that provably wrote it. Handing the string to MySQL's own `UUID_TO_BIN(x, 0)` —
 * the exact expression `0001_tenancy` used to write the reserved role ids — leaves
 * one definition of the encoding in the system instead of two. `UUID_TO_BIN` of a
 * bound parameter is constant per execution, so the composite indexes are still
 * used.
 *
 * A shared `src/db` helper is the better long-term home (OB-015 will want it for
 * sessions); it does not exist yet and this ticket does not own `src/db/`.
 */

/** The `BINARY(16)` form of a UUID, converted by the database itself. */
function binaryUuid(value: string): Expression<Buffer> {
  return sql<Buffer>`UUID_TO_BIN(${value}, 0)`;
}

/** `BINARY(16)` back to a UUID string, by the same authority. */
function uuidText<A extends string>(column: string, alias: A): AliasedRawBuilder<string, A> {
  return sql<string>`BIN_TO_UUID(${sql.ref(column)}, 0)`.as(alias);
}

/**
 * Shape check only. Callers decide what a malformed id means, because the two
 * cases differ: see `permissionsForContext` and `resolveMembership`.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * The shared-scope predicate for `roles`, against a literal org id.
 *
 * Kept as a function rather than inlined at both call sites so the `IS NULL` half
 * cannot be dropped from one of them and left in the other.
 */
function roleVisibleToOrg(orgId: string): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.ref('r.org_id')} = ${binaryUuid(orgId)} OR ${sql.ref('r.org_id')} IS NULL)`;
}

/**
 * The same predicate against `org_members.org_id` rather than a bound literal.
 *
 * Equivalent because the WHERE clause has already pinned `m.org_id` to the target
 * org, and it binds the org once instead of twice.
 */
function roleVisibleToMembersOrg(): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.ref('r.org_id')} = ${sql.ref('m.org_id')} OR ${sql.ref('r.org_id')} IS NULL)`;
}

/**
 * Every permission code a role carries, as seen from `orgId`.
 *
 * One query. It is the query the memoization in `permissions.service.ts` exists to
 * issue once per request rather than once per check.
 *
 * Unknown codes are dropped rather than surfaced: see `isPermissionKey`.
 */
export async function selectRolePermissionKeys(
  roleId: string,
  orgId: string,
): Promise<readonly PermissionKey[]> {
  const rows = await systemDb()
    .selectFrom('roles as r')
    .innerJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .select('rp.permission_code as permission_code')
    .where('r.id', '=', binaryUuid(roleId))
    .where(roleVisibleToOrg(orgId))
    .execute();

  return rows.map((row) => row.permission_code).filter(isPermissionKey);
}

/** A membership's role and the permissions it bundles. */
export interface RoleMembership {
  readonly roleId: string;
  readonly roleCode: string;
  readonly permissions: readonly PermissionKey[];
}

/**
 * The role a user holds in one org, with its permissions, or `undefined`.
 *
 * `org_members` is many-to-many by design (spec §5) — one login is Owner of their
 * own books and Read-only/Accountant on a client's — so "which role" is only ever
 * a question about a *pair*, never about a user. Nothing here reads
 * `sessions.active_org_id`: that column is a preference to be re-validated, and
 * this function is the re-validation (see the `sessions` commentary in
 * `0001_tenancy.ts`).
 *
 * One query rather than a membership lookup followed by a permission lookup, since
 * this runs on the request path. The join to `role_permissions` is a LEFT JOIN
 * specifically so that a role bundling *no* permissions still returns a row —
 * otherwise "member, holding a role that grants nothing" and "not a member" would
 * be the same empty result set, and they must not be: the first is a caller who
 * gets `403`s, the second is a caller who must be told nothing at all (A7).
 */
export async function selectMembershipRole(
  userId: string,
  orgId: string,
): Promise<RoleMembership | undefined> {
  const rows = await systemDb()
    .selectFrom('org_members as m')
    .innerJoin('roles as r', (join) =>
      join.onRef('r.id', '=', 'm.role_id').on(roleVisibleToMembersOrg()),
    )
    .leftJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .select([uuidText('r.id', 'role_id'), 'r.code as role_code', 'rp.permission_code'])
    .where('m.org_id', '=', binaryUuid(orgId))
    .where('m.user_id', '=', binaryUuid(userId))
    .execute();

  const [first] = rows;
  if (first === undefined) return undefined;

  return {
    roleId: first.role_id,
    roleCode: first.role_code,
    permissions: rows
      .map((row) => row.permission_code)
      .filter((code): code is string => code !== null)
      .filter(isPermissionKey),
  };
}

/**
 * The seeded catalog, straight from the table.
 *
 * Only the drift test uses it, and that is the point — nothing in the enforcement
 * path reads the catalog at runtime, so a stale database cannot widen what a
 * service is able to check. Exported from the repository rather than written as
 * raw SQL in the test so the test and the resolution path agree on which database
 * handle they mean.
 */
export async function selectCatalogCodes(): Promise<readonly string[]> {
  const rows = await systemDb().selectFrom('permissions').select('code').execute();
  return rows.map((row) => row.code);
}
