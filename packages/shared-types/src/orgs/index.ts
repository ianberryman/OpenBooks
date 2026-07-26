/**
 * The org and membership wire contract (OB-023). Read `orgs.ts` for why no request
 * schema accepts a slug and why there is no org-update shape in M1.
 */
export type { CreateOrgRequest, OrgMembershipList, SwitchActiveOrgRequest } from './orgs';
export {
  createOrgRequestSchema,
  orgMembershipListSchema,
  orgMembershipSchema,
  orgSummarySchema,
  switchActiveOrgRequestSchema,
} from './orgs';
