import type { AliasedRawBuilder, Expression, SqlBool } from 'kysely';
import { sql } from 'kysely';

import { newUuid, systemDb } from '../../db';
import type { PermissionKey } from '../permissions/catalog';
import { isPermissionKey } from '../permissions/catalog';

/**
 * Data access for custom roles (OB-226, the ROLES initiative; spec §5's v2 role
 * editor).
 *
 * ## Why `systemDb()` and not `tenantDb()`
 *
 * `roles` is the table `src/db/tenant-tables.ts` deliberately excludes from the
 * tenant set: its `org_id` is nullable, and NULL means "system role, shared by
 * every org" (the six seeded roles all are). `tenantDb`'s wrapper injects a bare
 * `org_id = ?`, which would make every seeded role invisible to a scoped read and
 * would leave a scoped write with no way to express "insert with `org_id = NULL`"
 * even if that were ever wanted. So every statement here goes through `systemDb()`
 * and this module writes its own `org_id` predicate by hand, copied from
 * `permissions.repository.ts` — the first place this exact problem was solved —
 * rather than reinventing it slightly differently.
 *
 * ## Two predicates, not one
 *
 * A write must never reach a system role or another org's role, so every mutation
 * below is **strict**: `org_id = <org> AND is_system = 0`. `selectRoleDetail` is
 * the one exception — it also has to resolve a *system* role, so an editor can
 * show what "Bookkeeper" grants without being able to touch it — so it alone uses
 * the **visible** predicate: `org_id = <org> OR org_id IS NULL`. Keeping the visible
 * predicate as its own function (`roleVisible`, parameterized by which column ref to
 * use) is what stops it from migrating into a write path by accident.
 *
 * ## Why ids are handed to MySQL as UUID strings
 *
 * Same reason as `permissions.repository.ts`: `UUID_TO_BIN`/`BIN_TO_UUID` are the
 * one definition of the byte order in the system, so every id here is converted by
 * the database itself rather than by a second, independently-written copy of
 * `uuid.ts`'s conversion.
 */

/** The `BINARY(16)` form of a UUID, converted by the database itself. */
function binaryUuid(value: string): Expression<Buffer> {
  return sql<Buffer>`UUID_TO_BIN(${value}, 0)`;
}

/** `BINARY(16)` back to a UUID string, by the same authority, aliased for a select. */
function uuidText<A extends string>(column: string, alias: A): AliasedRawBuilder<string, A> {
  return sql<string>`BIN_TO_UUID(${sql.ref(column)}, 0)`.as(alias);
}

/**
 * `(<column> = <org> OR <column> IS NULL)`, against a literal org id.
 *
 * `column` is a parameter rather than a fixed `'org_id'` because the one caller
 * that needs this predicate (`selectRoleDetail`) reaches `roles` through an alias
 * (`r`), and a second, differently-spelled copy of this predicate is exactly how
 * the `IS NULL` half — the part that admits the six seeded roles — gets dropped
 * from one call site and kept at the other.
 */
function roleVisible(orgId: string, column: string): Expression<SqlBool> {
  return sql<SqlBool>`(${sql.ref(column)} = ${binaryUuid(orgId)} OR ${sql.ref(column)} IS NULL)`;
}

export interface NewRoleInput {
  readonly code: string;
  readonly name: string;
  readonly description: string;
}

export interface RoleForWrite {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
}

export interface RoleDetailRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly isSystem: boolean;
  readonly permissionKeys: readonly PermissionKey[];
}

export interface PermissionCatalogRow {
  readonly code: string;
  readonly description: string;
}

/** Creates a custom role in `orgId`, `is_system = 0`. Returns the new role's id. */
export async function insertRole(orgId: string, input: NewRoleInput): Promise<string> {
  const id = newUuid();

  await systemDb()
    .insertInto('roles')
    .values({
      id: binaryUuid(id),
      org_id: binaryUuid(orgId),
      code: input.code,
      name: input.name,
      description: input.description,
      is_system: 0,
    })
    .execute();

  return id;
}

/** Bulk-inserts a role's permission bundle. A no-op for an empty set. */
export async function insertRolePermissions(
  roleId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return;

  await systemDb()
    .insertInto('role_permissions')
    .values(keys.map((code) => ({ role_id: binaryUuid(roleId), permission_code: code })))
    .execute();
}

export async function deleteRolePermissions(roleId: string): Promise<void> {
  await systemDb()
    .deleteFrom('role_permissions')
    .where('role_id', '=', binaryUuid(roleId))
    .execute();
}

/**
 * Renames/redescribes a custom role. `code` is not a parameter — it never
 * changes after creation (see `roles.service.ts`).
 *
 * Strict predicate: only a non-system role in `orgId` can be affected, so a
 * system-role id or another org's role id updates zero rows rather than one that
 * does not belong to the caller.
 */
export async function updateRoleRow(
  orgId: string,
  roleId: string,
  input: { readonly name: string; readonly description: string },
): Promise<number> {
  const result = await systemDb()
    .updateTable('roles')
    .set({ name: input.name, description: input.description })
    .where('id', '=', binaryUuid(roleId))
    .where('org_id', '=', binaryUuid(orgId))
    .where('is_system', '=', 0)
    .executeTakeFirst();

  return Number(result.numUpdatedRows);
}

/** Same strict predicate as `updateRoleRow`. `role_permissions` cascades on delete. */
export async function deleteRoleRow(orgId: string, roleId: string): Promise<number> {
  const result = await systemDb()
    .deleteFrom('roles')
    .where('id', '=', binaryUuid(roleId))
    .where('org_id', '=', binaryUuid(orgId))
    .where('is_system', '=', 0)
    .executeTakeFirst();

  return Number(result.numDeletedRows);
}

/** The strict read a write path checks before acting — see `updateRoleRow`/`deleteRoleRow`. */
export async function selectRoleForWrite(
  orgId: string,
  roleId: string,
): Promise<RoleForWrite | undefined> {
  return systemDb()
    .selectFrom('roles')
    .select([uuidText('id', 'id'), 'code', 'name', 'description'])
    .where('id', '=', binaryUuid(roleId))
    .where('org_id', '=', binaryUuid(orgId))
    .where('is_system', '=', 0)
    .executeTakeFirst();
}

/**
 * A role and the keys it bundles, under the **visible** predicate — the one read
 * in this module that must also resolve a system role (see the module header).
 * Unrecognised codes are dropped rather than surfaced, matching
 * `selectRolePermissionKeys` in `permissions.repository.ts`.
 */
export async function selectRoleDetail(
  orgId: string,
  roleId: string,
): Promise<RoleDetailRow | undefined> {
  const rows = await systemDb()
    .selectFrom('roles as r')
    .leftJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .select([
      uuidText('r.id', 'id'),
      'r.code as code',
      'r.name as name',
      'r.description as description',
      'r.is_system as is_system',
      'rp.permission_code as permission_code',
    ])
    .where('r.id', '=', binaryUuid(roleId))
    .where(roleVisible(orgId, 'r.org_id'))
    .execute();

  const [first] = rows;
  if (first === undefined) return undefined;

  return {
    id: first.id,
    code: first.code,
    name: first.name,
    description: first.description,
    isSystem: first.is_system !== 0,
    permissionKeys: rows
      .map((row) => row.permission_code)
      .filter((code): code is string => code !== null)
      .filter(isPermissionKey),
  };
}

/**
 * Whether `code` already names a role visible to `orgId` — a same-org custom role
 * or one of the six seeded ones. Both are refused: the second blocks a custom
 * role's slug from colliding with a system code, which would make `code` an
 * ambiguous key the moment anything looked it up without an `is_system` filter.
 */
export async function roleCodeTaken(orgId: string, code: string): Promise<boolean> {
  const row = await systemDb()
    .selectFrom('roles')
    .select('id')
    .where(roleVisible(orgId, 'org_id'))
    .where('code', '=', code)
    .limit(1)
    .executeTakeFirst();

  return row !== undefined;
}

/**
 * Whether any membership or outstanding invite still names this role — the
 * delete guard (`roles.service.ts`'s `deleteRole`).
 *
 * `org_members` and `org_invites` are tenant tables, reached here through
 * `systemDb()` rather than `tenantDb()`. That is not a second unscoped-tenant-read
 * bug waiting to happen: it is the same shape `permissions.repository.ts`'s
 * `selectMembershipRole` already uses to resolve a role across the system, and
 * `role_id` is a `BINARY(16)` primary-key reference that only ever names rows in
 * the one org the role was created in — there is no second org's rows an
 * unscoped `role_id = ?` could reach.
 */
export async function membershipReferencesRole(roleId: string): Promise<boolean> {
  const key = binaryUuid(roleId);

  const [member, invite] = await Promise.all([
    systemDb()
      .selectFrom('org_members')
      .select('user_id')
      .where('role_id', '=', key)
      .limit(1)
      .executeTakeFirst(),
    systemDb()
      .selectFrom('org_invites')
      .select('id')
      .where('role_id', '=', key)
      .limit(1)
      .executeTakeFirst(),
  ]);

  return member !== undefined || invite !== undefined;
}

/** The fixed catalog, straight from the table — for the role-builder checklist. */
export async function selectPermissionCatalog(): Promise<readonly PermissionCatalogRow[]> {
  return systemDb().selectFrom('permissions').select(['code', 'description']).execute();
}
