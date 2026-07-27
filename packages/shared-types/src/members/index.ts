/**
 * The members and invitations wire contract (OB-040, OB-045).
 *
 * Read `members.ts` for why an invitation's token is never in a response, for why
 * an invitation carries its `orgId` where other resources do not, and for why the
 * request schemas are still in `server/src/modules/members/input.ts`.
 */

export type {
  AcceptedInvitation,
  AssignableRole,
  AssignableRoleList,
  Invitation,
  InvitationList,
  InvitationStatus,
  IssuedInvitation,
  OrgMember,
  OrgMemberList,
} from './members';
export {
  acceptedInvitationSchema,
  assignableRoleListSchema,
  assignableRoleSchema,
  INVITATION_STATUSES,
  invitationListSchema,
  invitationSchema,
  issuedInvitationSchema,
  orgMemberListSchema,
  orgMemberSchema,
} from './members';
