/**
 * Permission catalog and enforcement (spec §5, OB-016).
 *
 * Read `catalog.ts` for why the union is stated rather than derived and how it is
 * held to the seeded table, `permissions.repository.ts` for why `roles` needs
 * `org_id = ? OR org_id IS NULL`, and `permissions.service.ts` for why the
 * role → permission memo is keyed by the request context rather than by role id.
 *
 * Service code imports `requirePermission` from here. Transport code imports
 * nothing from here except, at most, `./catalog` — enforcement is service-layer
 * only (spec §2.4, §5).
 */
export type { PermissionKey } from './catalog';
export { isPermissionKey, PERMISSION_KEYS } from './catalog';

export type { MembershipResolution } from './permissions.service';
export {
  hasPermission,
  permissionsForContext,
  requirePermission,
  resolveMembership,
} from './permissions.service';

export type { RoleMembership } from './permissions.repository';
export { selectCatalogCodes } from './permissions.repository';
