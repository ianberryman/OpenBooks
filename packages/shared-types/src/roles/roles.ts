/**
 * The custom-role wire contract (OB-226, the ROLES initiative).
 *
 * A custom role is a per-org row (`roles.org_id = <org>`, `is_system = 0`) assembling
 * keys from the fixed permission catalog. The read side — listing a role and assigning
 * it — already ships in the members contract: `assignableRoleSchema` carries the
 * `isSystem` flag purpose-built to tell a custom role from the seeded seven, and
 * `GET /v1/roles` returns both. So this module adds only the *authoring* shapes: the
 * create/update request bodies and the permission catalog a builder renders a checklist
 * over. Create and update both answer with an `AssignableRole` (from `members`), so no
 * new response schema is defined here.
 *
 * `permissionKeys` is typed `string[]` on the wire, not an enum: the catalog
 * (`server/src/modules/permissions/catalog.ts`) is server-only by design — the
 * enforcement path never reads it at runtime — so the *service* validates each key
 * against it and rejects an unknown, which is the one place that check belongs.
 */

import { z } from 'zod';

/** `roles.name` is `VARCHAR(120)`; `roles.description` is `VARCHAR(255)`. */
const MAX_ROLE_NAME_LENGTH = 120;
const MAX_ROLE_DESCRIPTION_LENGTH = 255;

const roleNameSchema = z.string().trim().min(1).max(MAX_ROLE_NAME_LENGTH);
const roleDescriptionSchema = z.string().trim().max(MAX_ROLE_DESCRIPTION_LENGTH);

/**
 * The keys a role bundles. Deduped so a checklist that submits a code twice is not a
 * validation error, and unconstrained in value because the catalog lives server-side —
 * the service intersects this with `PERMISSION_KEYS` and refuses an unknown code.
 * Empty is permitted: a role that grants nothing is a valid (if unusual) row, and the
 * resolution join already returns it as a member who gets 403s rather than as a
 * non-member.
 */
const permissionKeysSchema = z.array(z.string()).transform((keys) => [...new Set(keys)]);

/**
 * One role with the keys it bundles — what an editor prefills from.
 *
 * The list read (`assignableRoleSchema`, in `members`) is deliberately keyless: a
 * picker needs the name, not the grant set. Editing a custom role needs the set, so
 * this is its own read (`GET /v1/roles/{roleId}`) rather than a widening of the list
 * row every consumer already depends on. `permissionKeys` is a plain `string[]`: a
 * client renders it against the catalog and a stale code (one dropped from the catalog)
 * simply does not match a checklist entry.
 */
export const roleDetailSchema = z
  .strictObject({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string(),
    isSystem: z.boolean(),
    permissionKeys: z.array(z.string()),
  })
  .meta({ id: 'RoleDetail', description: 'A role and the permission keys it grants.' });

export type RoleDetail = z.infer<typeof roleDetailSchema>;

export const createRoleRequestSchema = z
  .strictObject({
    name: roleNameSchema,
    description: roleDescriptionSchema,
    permissionKeys: permissionKeysSchema,
  })
  .meta({
    id: 'CreateRoleRequest',
    description: 'Create a custom role in this organization from permission-catalog keys.',
  });

export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z
  .strictObject({
    name: roleNameSchema,
    description: roleDescriptionSchema,
    permissionKeys: permissionKeysSchema,
  })
  .meta({
    id: 'UpdateRoleRequest',
    description: 'Replace a custom role’s name, description, and full permission set.',
  });

export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

/**
 * One entry in the permission catalog a builder renders as a checklist.
 *
 * `group` is the key prefix before the dot (`journals`, `banking`, …), so the UI can
 * section the checklist without a second source of grouping. `description` is the
 * human-readable label seeded alongside each code in the `permissions` table.
 */
export const permissionCatalogEntrySchema = z
  .strictObject({
    code: z.string(),
    description: z.string(),
    group: z.string(),
  })
  .meta({ id: 'PermissionCatalogEntry', description: 'A single assignable permission.' });

export type PermissionCatalogEntry = z.infer<typeof permissionCatalogEntrySchema>;

export const permissionCatalogSchema = z
  .strictObject({
    permissions: z.array(permissionCatalogEntrySchema),
  })
  .meta({
    id: 'PermissionCatalog',
    description: 'Every permission a custom role may include, for the role builder.',
  });

export type PermissionCatalog = z.infer<typeof permissionCatalogSchema>;
