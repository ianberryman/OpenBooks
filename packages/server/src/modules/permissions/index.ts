/**
 * Permission catalog and enforcement (spec §5, OB-016).
 *
 * Read `catalog.ts` for why the union is stated rather than derived and how it is
 * held to the seeded table, `permissions.repository.ts` for why `roles` needs
 * `org_id = ? OR org_id IS NULL`, and `permissions.service.ts` for why the
 * role → permission memo is keyed by the request context rather than by role id.
 *
 * Service code imports `requirePermission` from here. Transport imports exactly one
 * name — `currentPermissions`, which authorizes nothing and is the advisory list
 * `GET /v1/auth/me` returns for the UI (ROADMAP D-25). Enforcement stays
 * service-layer only (spec §2.4, §5); a route that reached for `requirePermission`
 * or `hasPermission` would be a second enforcement point, which is the whole thing
 * the rule prevents.
 */
export type { PermissionKey } from './catalog';
export { isPermissionKey, PERMISSION_KEYS } from './catalog';

export type { MembershipResolution } from './permissions.service';
export {
  currentPermissions,
  hasPermission,
  permissionsForContext,
  requirePermission,
  resolveMembership,
} from './permissions.service';

export type { RoleMembership } from './permissions.repository';
export { selectCatalogCodes } from './permissions.repository';
