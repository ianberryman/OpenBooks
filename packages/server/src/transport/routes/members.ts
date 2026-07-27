import {
  acceptedInvitationSchema,
  assignableRoleListSchema,
  invitationListSchema,
  invitationSchema,
  issuedInvitationSchema,
  orgMemberListSchema,
  orgMemberSchema,
} from '@openbooks/shared-types';
import type {
  AcceptedInvitation,
  AssignableRoleList,
  Invitation,
  InvitationList,
  IssuedInvitation,
  OrgMember,
  OrgMemberList,
} from '@openbooks/shared-types';
import { z } from 'zod';

import { getContext } from '../../context';
import { withGlobalIdempotency, withIdempotency } from '../../modules/idempotency';
import {
  acceptInvite,
  changeMemberRole,
  inviteMember,
  listAssignableRoles,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
} from '../../modules/members';
import { acceptInviteRequestSchema, inviteMemberRequestSchema } from '../../modules/members/input';
import { requireIdempotencyKey } from '../idempotency';
import type { App } from '../types';
import {
  ERROR_RESPONSES,
  ORG_SCOPED_WRITE_HOOKS,
  idempotencyKeyHeaderSchema,
  idempotentBody,
  noContentSchema,
  requireOrgScope,
  wireList,
} from './support';

/**
 * `/v1/members`, `/v1/roles`, `/v1/invites` — who is in the org and how they got
 * there (OB-040; spec §5, spec §1).
 *
 * ## Why the request schemas come from the module and not from shared-types
 *
 * Every other route file in this directory reads its bodies from
 * `@openbooks/shared-types`. Two of these come from
 * `src/modules/members/input.ts`, where OB-040 put them because it shipped no
 * routes and a published contract for an endpoint that does not exist is one the
 * drift gate cannot check. That file says they move to shared-types with the
 * routes that need them, and this ticket could not complete the move — the module
 * was held elsewhere for the duration. Copying them instead would have left two
 * authorities on what an invitation may say, which is worse than one import
 * pointing the wrong way: nothing about `openapi.json` differs, because a body
 * schema is a body schema wherever it is declared. The responses *are* in
 * shared-types, because they did not exist before this ticket.
 *
 * ## The target of a member operation is the path and not the body
 *
 * `changeMemberRole(input, ctx)` takes `{ userId, roleId }`, because a service has
 * no path to read a target from — an MCP tool calling it names both. Over HTTP the
 * target *is* the resource, so the published body carries only the role and the
 * route supplies `userId` from the path. That is argument mapping in the
 * `RequestContext` sense: it removes a way for a caller to name one person in the
 * URL and another in the body, and it leaves the service's signature alone.
 *
 * ## The three refusals this file does not implement, and must not
 *
 * An org cannot lose its last Owner, an invitation cannot be revoked once
 * accepted, and an accepted invite cannot re-role an existing member. All three
 * live in the services, under the row locks that make them true rather than
 * likely. A route that pre-checked any of them would be a second answer that can
 * disagree with the first (spec §2.4, §5).
 */

const TAG = 'members';

const memberParamsSchema = z.strictObject({ userId: z.uuid() });
const inviteParamsSchema = z.strictObject({ inviteId: z.uuid() });

/**
 * `changeMemberRole`'s body with the path's copy of `userId` removed.
 *
 * The service takes `{ userId, roleId }` because it has no path to read the target
 * from — an MCP tool calling it names both. On HTTP the target is the resource, so
 * publishing it in the body as well would give a caller two places to name a person
 * and a way to make them differ.
 */
const changeMemberRoleBodySchema = z.strictObject({ roleId: z.uuid() }).meta({
  id: 'ChangeMemberRoleRequest',
  description:
    'The role the member holds afterwards. Re-roling to the role they already hold succeeds ' +
    'and changes nothing: a client reconciling state should not have to know the current ' +
    'value in order to write the intended one.',
});

/**
 * The module's schemas, given a published name.
 *
 * `.meta()` clones and registers the clone, so this names the component without
 * making a second authority on what the request may contain: the services parse the
 * originals, and the only difference between the two objects is the metadata. It is
 * what lets the bodies be `$ref`d by the generated client while the schemas
 * themselves stay where OB-040 left them.
 */
const inviteMemberBodySchema = inviteMemberRequestSchema.meta({
  id: 'InviteMemberRequest',
  description:
    'An address and the role it is invited to hold. The address is lowercased and trimmed, ' +
    'because the accept path compares an invited address against a registered one in ' +
    'application code, where there is no collation to fall back on.',
});

const acceptInviteBodySchema = acceptInviteRequestSchema.meta({
  id: 'AcceptInviteRequest',
  description:
    'The organization and the token, both taken from the invitation link. Neither is checked ' +
    'for shape beyond being a string: a token of the wrong length must fail as a miss, not as ' +
    'a `400` telling its holder their guess was malformed.',
});

export function registerMemberRoutes(app: App): void {
  app.get(
    '/v1/members',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listMembers',
        summary: 'List the organization’s members',
        description:
          'Takes `members.read`. `isActive` is the user’s own flag rather than the ' +
          'membership’s — a deactivated user keeps their membership, and an administrator ' +
          'reading this list is exactly who needs to see that. Unpaginated in M2: the target ' +
          'business is an owner plus a bookkeeper.',
        tags: [TAG],
        response: { 200: orgMemberListSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<OrgMemberList> => ({ members: wireList(await listMembers(getContext())) }),
  );

  /**
   * `PATCH` and not `PUT`: a membership is more than its role — it carries who
   * invited it and when it was made — and a `PUT` would mean "replace", which is
   * not an operation this system has.
   */
  app.patch(
    '/v1/members/:userId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'changeMemberRole',
        summary: 'Change what a member may do',
        description:
          'Takes `members.write`. An org cannot lose its last Owner: demoting the only one is a ' +
          '`precondition_failed`, decided under a lock on the Owner set rather than a count, so ' +
          'two callers each demoting the other’s Owner cannot both succeed.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: memberParamsSchema,
        body: changeMemberRoleBodySchema,
        response: { 200: orgMemberSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { userId } = request.params;
      const { roleId } = request.body;
      const result = await withIdempotency(
        { endpoint: 'changeMemberRole', request: { userId, roleId }, successStatus: 200 },
        () => changeMemberRole({ userId, roleId }, ctx),
      );

      return reply.status(result.status).send(idempotentBody<OrgMember>(result));
    },
  );

  app.delete(
    '/v1/members/:userId',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'removeMember',
        summary: 'Remove a member from the organization',
        description:
          'Takes `members.write`. Removes the membership and nothing else — the user account is ' +
          'not touched, and every journal they posted keeps naming them, because an actor on a ' +
          'posted entry is a fact rather than a link. The last Owner cannot be removed.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: memberParamsSchema,
        response: { 204: noContentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { userId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'removeMember', request: { userId }, successStatus: 204 },
        () => removeMember({ userId }, ctx),
      );

      return reply.status(result.status).send(idempotentBody<null>(result));
    },
  );

  /**
   * `roles.read` and not `members.read`, which is why it is its own path rather
   * than `/v1/members/roles`. The catalog is a different subject from the people:
   * the seeded Read-only role can see what "Bookkeeper" means without being able to
   * see who holds it.
   */
  app.get(
    '/v1/roles',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listAssignableRoles',
        summary: 'List the roles this organization may grant',
        description:
          'Takes `roles.read`. `code` is the half to branch on — the six system roles have ' +
          'stable codes and per-deployment ids, so a screen keyed on the id is keyed on a value ' +
          'that differs between two installations of the same product.',
        tags: [TAG],
        response: { 200: assignableRoleListSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<AssignableRoleList> => ({
      roles: wireList(await listAssignableRoles(getContext())),
    }),
  );

  app.post(
    '/v1/invites',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'inviteMember',
        summary: 'Invite an address to the organization',
        description:
          'Takes `members.write`. The response carries `emailDelivered`, and it can be false: ' +
          'the send happens after the commit and must never fail the write, so a false here ' +
          'means the invitation exists and nobody was told. Reissue rather than assume. The ' +
          'token is never returned — it is a credential, held only as a hash.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: inviteMemberBodySchema,
        response: { 201: issuedInvitationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const result = await withIdempotency(
        { endpoint: 'inviteMember', request: request.body, successStatus: 201 },
        () => inviteMember(request.body, ctx),
      );

      return reply.status(result.status).send(idempotentBody<IssuedInvitation>(result));
    },
  );

  app.get(
    '/v1/invites',
    {
      onRequest: requireOrgScope,
      schema: {
        operationId: 'listInvites',
        summary: 'List the organization’s invitations',
        description:
          'Takes `members.read`. `expired` is derived from the clock on every read rather than ' +
          'stored: a stored status would be wrong between the moment an invitation lapses and ' +
          'whatever job noticed, and there is no such job.',
        tags: [TAG],
        response: { 200: invitationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<InvitationList> => ({ invites: wireList(await listInvites(getContext())) }),
  );

  app.post(
    '/v1/invites/:inviteId/revoke',
    {
      onRequest: ORG_SCOPED_WRITE_HOOKS,
      schema: {
        operationId: 'revokeInvite',
        summary: 'Withdraw an invitation',
        description:
          'Takes `members.write`. Revoking an already-revoked invitation succeeds and changes ' +
          'nothing — it is the same request stated twice. Revoking an *accepted* one is refused ' +
          'with `invite_already_accepted`: the person is a member now, and the operation that ' +
          'undoes that is removing them, which carries the last-Owner rule. An expired ' +
          'invitation may still be revoked; that is how an administrator says so on the list.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        params: inviteParamsSchema,
        response: { 200: invitationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const ctx = getContext();
      const { inviteId } = request.params;
      const result = await withIdempotency(
        { endpoint: 'revokeInvite', request: { inviteId }, successStatus: 200 },
        () => revokeInvite({ inviteId }, ctx),
      );

      return reply.status(result.status).send(idempotentBody<Invitation>(result));
    },
  );

  /**
   * The one write in this file with **no org scope**, and therefore a global claim.
   *
   * The caller is by definition not yet a member of the org they are joining, so
   * their context is scoped to some other org or to none — `requireOrgScope` would
   * refuse a request the service is designed to accept, and an org-scoped claim
   * would be recorded against whichever org they happened to be in. It joins
   * register, login, logout, create-org and switch-org in the namespace `claim_scope`
   * exists for (OB-028, migration `0003`), whose fingerprint folds in the calling
   * user — which matters more here than anywhere: the key is client-chosen, the
   * namespace is shared, and without the caller in the hash two clients that picked
   * the same key would be each other's replays.
   *
   * `/v1/invites/accept` rather than `/v1/invites/{inviteId}/accept`: the credential
   * is the token, and the invitation's id is not something its holder has. Naming
   * the row in the path would also make a `404` for a bad id distinguishable from a
   * `404` for a bad token, which is the distinction A7 removes — the service resolves
   * the invitation *by token hash* and answers one indistinguishable miss for a
   * malformed org, another tenant's invitation, a revoked one, and one that never
   * existed.
   */
  app.post(
    '/v1/invites/accept',
    {
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'acceptInvite',
        summary: 'Redeem an invitation and join the organization',
        description:
          'Authorized by the token plus the caller’s registered address matching the invited ' +
          'one — without that second half, a forwarded link is a membership for whoever opens ' +
          'it. The caller must already be signed in: an invitation names an address, not an ' +
          'account, and is not a second way to register. Single use, decided by a locking read ' +
          'rather than a check. A caller who is already a member consumes the invitation and ' +
          'keeps the role they have (`joined: false`) — an invitation issued as Read-only must ' +
          'not be a way to demote an Owner who clicked it.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: acceptInviteBodySchema,
        response: { 200: acceptedInvitationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withGlobalIdempotency(
        { endpoint: 'acceptInvite', request: request.body, successStatus: 200 },
        () => acceptInvite(request.body),
      );

      return reply.status(result.status).send(idempotentBody<AcceptedInvitation>(result));
    },
  );
}
