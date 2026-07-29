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

export type { OrgRow } from './orgs.repository';
// `selectOrg` is exported for the invite email, which names the org it invites
// someone to (OB-040). A read of a single non-tenant row by primary key, and the
// alternative — a second copy of the same two-line query inside `modules/members`
// — would be a second answer to "what is this org called".
export { selectDefaultMemberOrgId, selectOrg } from './orgs.repository';

// The inbound bill-capture mailbox (initiative O, OB-186). `getInboundEmailAddress`
// is the org-scoped read/mint the transport surface exposes;
// `resolveOrgIdForInboundToken` is the one unauthenticated lookup the inbound
// webhook route needs before any org context exists — `token.ts`'s shape,
// applied to a mailbox instead of a hosted invoice link.
export type { InboundEmailAddress } from './inbound-email';
export { getInboundEmailAddress, resolveOrgIdForInboundToken } from './inbound-email';
