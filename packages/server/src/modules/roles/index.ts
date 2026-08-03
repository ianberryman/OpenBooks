/**
 * Custom, per-org role authoring (OB-226; spec §5's v2 role editor).
 *
 * Read `roles.service.ts` for why the full permission catalog is authorable with
 * no special-casing (D-226-4) and `roles.repository.ts` for why every statement
 * here goes through `systemDb()` rather than `tenantDb()`. Role *resolution* — the
 * read that turns a role id into an effective permission set — already lives in
 * `modules/permissions`; nothing here duplicates it.
 *
 * No route lives in this module. `src/transport/routes/roles.ts` owns the HTTP
 * surface and calls these functions, which is what keeps them equally callable
 * from an MCP tool (M5) or the workflow engine (M6).
 */
export {
  createRole,
  deleteRole,
  getPermissionCatalog,
  getRoleDetail,
  updateRole,
} from './roles.service';
