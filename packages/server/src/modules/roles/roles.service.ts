import type {
  AssignableRole,
  CreateRoleRequest,
  PermissionCatalogEntry,
  RoleDetail,
  UpdateRoleRequest,
} from '@openbooks/shared-types';
import { createRoleRequestSchema, updateRoleRequestSchema } from '@openbooks/shared-types';

import type { RequestContext } from '../../context';
import { systemDb, withTransaction } from '../../db';
import { assertFound, ConflictError, parseInput, ValidationError } from '../../errors';
import { isPermissionKey } from '../permissions/catalog';
import { requirePermission } from '../permissions';

import {
  deleteRolePermissions,
  deleteRoleRow,
  insertRole,
  insertRolePermissions,
  membershipReferencesRole,
  roleCodeTaken,
  selectPermissionCatalog,
  selectRoleDetail,
  selectRoleForWrite,
  updateRoleRow,
} from './roles.repository';

/**
 * Custom, per-org role authoring (OB-226; spec §5's v2 role editor).
 *
 * `permissions.repository.ts` already resolves *any* role — seeded or custom —
 * into an effective permission set, so nothing here is needed to make a custom
 * role work at enforcement time; this module is purely the CRUD that populates
 * `roles`/`role_permissions` for a role the six-seed set does not cover.
 *
 * ## The full catalog is allowed, deliberately (D-226-4)
 *
 * `createRole`/`updateRole` validate every submitted key against
 * `isPermissionKey` and refuse an unrecognised one, and refuse nothing else. A
 * role naming `disbursements.issue` or `roles.write` itself is accepted exactly
 * as one naming `contacts.read` — there is no second, narrower catalog an
 * org-authored role is confined to. The separation-of-duties keys this would let
 * an org recombine (`pending_payments.write` + `disbursements.issue` on one
 * role, say) are a policy choice the org that owns its own books is entitled to
 * make; restricting it here would be a control this system asserts over an
 * org's internal governance that spec §5 never asks for.
 *
 * ## `systemDb()` + `withTransaction`, not `tenantDb()`
 *
 * `roles` is not a tenant table (see `roles.repository.ts`'s header), so there
 * is no `orgScope(ctx).transaction()` to reach for. `withTransaction(systemDb(),
 * …)` is its counterpart: every repository call inside the callback reaches
 * `systemDb()` again, and — because the callback runs inside
 * `runInTransactionScope` — each of those calls joins the same connection
 * ambiently (`src/db/transaction-scope.ts`) rather than needing the transaction
 * threaded through every signature.
 *
 * ## Why a miss is `assertFound` and not a distinct "that's a system role" error
 *
 * `selectRoleForWrite`'s predicate is strict: `org_id = <org> AND is_system = 0`.
 * A system-role id, another org's role id, and an id naming no row at all are
 * therefore one indistinguishable miss (A7) — exactly the shape `members.service.ts`
 * already established for a membership lookup.
 */

const ROLE_RESOURCE = 'role';

const MAX_ROLE_CODE_LENGTH = 64;

export async function createRole(
  input: CreateRoleRequest,
  ctx: RequestContext,
): Promise<AssignableRole> {
  await requirePermission(ctx, 'roles.write');
  const request = parseInput(createRoleRequestSchema, input);
  assertKnownPermissionKeys(request.permissionKeys);

  const code = slugifyRoleCode(request.name);

  return withTransaction(systemDb(), async () => {
    if (await roleCodeTaken(ctx.orgId, code)) {
      throw new ConflictError('A role with that name already exists.');
    }

    const id = await insertRole(ctx.orgId, {
      code,
      name: request.name,
      description: request.description,
    });
    await insertRolePermissions(id, request.permissionKeys);

    return { id, code, name: request.name, description: request.description, isSystem: false };
  });
}

/**
 * Replaces a custom role's name, description, and full permission set.
 *
 * `code` never appears in `UpdateRoleRequest` and this never rewrites it: the
 * slug is minted once, at creation, and an editor renaming a role keeps the
 * identifier anything that stored it (an audit log entry, a link) is still
 * resolving against.
 */
export async function updateRole(
  roleId: string,
  input: UpdateRoleRequest,
  ctx: RequestContext,
): Promise<AssignableRole> {
  await requirePermission(ctx, 'roles.write');
  const request = parseInput(updateRoleRequestSchema, input);
  assertKnownPermissionKeys(request.permissionKeys);

  return withTransaction(systemDb(), async () => {
    const role = assertFound(await selectRoleForWrite(ctx.orgId, roleId), ROLE_RESOURCE);

    await updateRoleRow(ctx.orgId, roleId, {
      name: request.name,
      description: request.description,
    });
    // Full replace, not a diff: `UpdateRoleRequest.permissionKeys` is the role's
    // whole intended bundle (see the wire contract), so the simplest correct
    // implementation is delete-then-reinsert rather than reconciling a delta.
    await deleteRolePermissions(roleId);
    await insertRolePermissions(roleId, request.permissionKeys);

    return {
      id: role.id,
      code: role.code,
      name: request.name,
      description: request.description,
      isSystem: false,
    };
  });
}

/**
 * Deletes a custom role, refusing while it is still in use.
 *
 * The guard is a live membership or a pending invite, not a historical one:
 * `journals`/`org_members` audit trails name an actor by id, never by role, so a
 * role that is no longer assigned leaves nothing dangling once it is gone.
 */
export async function deleteRole(roleId: string, ctx: RequestContext): Promise<void> {
  await requirePermission(ctx, 'roles.write');

  await withTransaction(systemDb(), async () => {
    assertFound(await selectRoleForWrite(ctx.orgId, roleId), ROLE_RESOURCE);

    if (await membershipReferencesRole(roleId)) {
      throw new ConflictError(
        'This role is assigned to members or pending invites and cannot be deleted.',
      );
    }

    await deleteRoleRow(ctx.orgId, roleId);
  });
}

export async function getRoleDetail(roleId: string, ctx: RequestContext): Promise<RoleDetail> {
  await requirePermission(ctx, 'roles.read');
  const row = assertFound(await selectRoleDetail(ctx.orgId, roleId), ROLE_RESOURCE);

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    permissionKeys: [...row.permissionKeys],
  };
}

/**
 * The catalog a role-builder checklist renders, grouped by the prefix before the
 * dot. Sorted so the wire body is stable across calls — the same reasoning
 * `currentPermissions` in `permissions.service.ts` gives for sorting its list.
 */
export async function getPermissionCatalog(
  ctx: RequestContext,
): Promise<readonly PermissionCatalogEntry[]> {
  await requirePermission(ctx, 'roles.read');
  const rows = await selectPermissionCatalog();

  return rows
    .map((row) => ({ code: row.code, description: row.description, group: groupOf(row.code) }))
    .sort((a, b) =>
      a.group === b.group ? a.code.localeCompare(b.code) : a.group.localeCompare(b.group),
    );
}

function groupOf(code: string): string {
  return code.split('.')[0] ?? code;
}

/**
 * Refuses a `permissionKeys` entry the fixed catalog does not recognise.
 *
 * The wire schema (`shared-types/roles`) deliberately types `permissionKeys` as
 * `string[]` and not an enum — the catalog is server-only by design (`catalog.ts`)
 * — so this is the one place the check belongs, before either write path acts on
 * the set.
 */
function assertKnownPermissionKeys(keys: readonly string[]): void {
  if (keys.every(isPermissionKey)) return;
  throw new ValidationError('permissionKeys contains an unknown permission');
}

/**
 * `name` → a `roles.code` slug: lowercase, non-alphanumeric runs collapsed to a
 * single `-`, trimmed of leading/trailing `-`, capped at the column width.
 *
 * Minted once, here, rather than left for the caller to supply: `roles.code` is
 * `VARCHAR(64)` and unique per org (`uq_roles_org_code`), and a client-supplied
 * slug would be one more thing `createRoleRequestSchema` would have to validate
 * for collision-proneness and column width instead of a display name that has
 * neither constraint.
 */
function slugifyRoleCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, MAX_ROLE_CODE_LENGTH)
    .replace(/-+$/, '');

  if (slug.length === 0) {
    throw new ValidationError('name must contain a letter or number');
  }
  return slug;
}
