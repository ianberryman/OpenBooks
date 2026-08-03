/**
 * The custom-role authoring wire contract (OB-226).
 *
 * Read `roles.ts` for why the read/assign shapes live in the members contract and only
 * the create/update requests and the permission catalog are here, and for why
 * `permissionKeys` is validated at the service rather than in the schema.
 */

export type {
  CreateRoleRequest,
  PermissionCatalog,
  PermissionCatalogEntry,
  RoleDetail,
  UpdateRoleRequest,
} from './roles';
export {
  createRoleRequestSchema,
  permissionCatalogEntrySchema,
  permissionCatalogSchema,
  roleDetailSchema,
  updateRoleRequestSchema,
} from './roles';
