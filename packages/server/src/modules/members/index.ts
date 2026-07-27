/**
 * Members and invitations (OB-040; spec §5, spec §1).
 *
 * Two services over three tables. `members.service.ts` is the people who are
 * already here — list, re-role, remove — and owns the rule that an org cannot lose
 * its last Owner. `invites.service.ts` is how someone becomes one of them, and is
 * the first consumer of an `EmailProvider` (ROADMAP D-07), which is why concrete
 * adapters land in `src/providers/` with this ticket and not before.
 *
 * Read `members.repository.ts:lockOwnerIds` for why the last-Owner check is a
 * locking read rather than a count, `tokens.ts` for why an invite token is stored
 * the way a session token is, and `invite-email.ts` for where the send sits
 * relative to the transaction and why it is not a queued job.
 *
 * No route lives here. OB-045 owns the HTTP surface; these are the functions it
 * will call, and they are equally callable from an MCP tool (M5) or the workflow
 * engine (M6) because none of them touches a request or a reply.
 */
export type { AssignableRole, OrgMember } from './members.service';
export {
  changeMemberRole,
  listAssignableRoles,
  listMembers,
  removeMember,
} from './members.service';

export type {
  AcceptedInvitation,
  Invitation,
  InvitationStatus,
  IssuedInvitation,
} from './invites.service';
export { acceptInvite, inviteMember, listInvites, revokeInvite } from './invites.service';

export type {
  AcceptInviteRequest,
  ChangeMemberRoleRequest,
  InviteMemberRequest,
  RemoveMemberRequest,
  RevokeInviteRequest,
} from './input';

export { INVITE_TTL_MS } from './tokens';
