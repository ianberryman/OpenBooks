/**
 * The org and membership wire contract (OB-023). Read `orgs.ts` for why no request
 * schema accepts a slug and why there is no org-update shape in M1, and
 * `settings.ts` for the control-account nominations M3 needs and what changing one
 * means for documents already posted.
 */
export type { CreateOrgRequest, OrgMembershipList, SwitchActiveOrgRequest } from './orgs';
export {
  createOrgRequestSchema,
  orgMembershipListSchema,
  orgMembershipSchema,
  orgSummarySchema,
  switchActiveOrgRequestSchema,
} from './orgs';
export type { ControlAccounts, UpdateControlAccountsRequest } from './settings';
export { controlAccountsSchema, updateControlAccountsRequestSchema } from './settings';
