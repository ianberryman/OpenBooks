/**
 * Orgs and org membership (spec §5, OB-015).
 *
 * The switcher itself is in `src/modules/auth/` — it writes `sessions.active_org_id`
 * — and calls `resolveOrgMembership` here for the part that decides whether the
 * switch is permitted. Read that function's commentary for the A7 conversion; it is
 * the single place "not a member" becomes "no such org".
 */
export type { OrgCreationInput, OrgMembership, OrgSummary } from './orgs.service';
export {
  createOrg,
  createOrgIn,
  listMemberships,
  OWNER_ROLE_CODE,
  OWNER_ROLE_ID,
  resolveOrgMembership,
} from './orgs.service';

export { selectDefaultMemberOrgId } from './orgs.repository';
