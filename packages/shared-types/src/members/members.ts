import { z } from 'zod';

/**
 * The members and invitations wire contract (OB-040, OB-045; spec §5).
 *
 * ## Why this file holds responses and not requests
 *
 * Every other module keeps both halves here, because both are the wire contract.
 * This one is split, and the split is a state rather than a design: OB-040 shipped
 * no routes, so it put its request schemas in `server/src/modules/members/input.ts`
 * — a published contract for an endpoint that did not exist would have been
 * unverifiable by the drift gate — and left a note saying they move here with the
 * routes that need them. OB-045 built the routes and could not finish the move: the
 * module was held by another agent for the duration, and copying the schemas rather
 * than moving them would have left two authorities on what an invitation may say.
 *
 * So the routes import the request schemas from the module and name them in the
 * published document from there. Nothing about the artifact differs — a body schema
 * is a body schema wherever it is declared — and the residue is one import in
 * `src/transport/routes/members.ts` that points into a module instead of into this
 * package. Completing the move is a file move plus a re-export, and it changes no
 * bytes in `openapi.json`.
 *
 * The response shapes below are genuinely new. `members.service.ts` and
 * `invites.service.ts` describe what they return as TypeScript interfaces, which is
 * a type and not a contract: a type cannot be published, cannot be `$ref`d by the
 * generated client, and cannot fail a build when it stops matching what a route
 * says. These schemas are the contract those interfaces are checked against, at the
 * route's return position.
 */

/**
 * One membership: who, and what they may do.
 *
 * `isActive` is the *user's* flag and not the membership's. A deactivated user
 * keeps their membership — deactivation is an account-level fact — and an
 * administrator reading the member list is exactly who needs to see that.
 *
 * `roleCode` is beside `roleId` because it is the half a client may branch on. The
 * six system roles are seeded with stable codes (`owner`, `bookkeeper`, …) while
 * their ids are per-deployment rows, so a screen keying off the id would be keying
 * off a value that differs between two installations of the same product.
 */
export const orgMemberSchema = z
  .strictObject({
    userId: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    isActive: z.boolean(),
    roleId: z.uuid(),
    roleCode: z.string(),
    roleName: z.string(),
    invitedByUserId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({
    id: 'OrgMember',
    description: 'One person’s membership of this organization, with the role they hold in it.',
  });

export type OrgMember = z.infer<typeof orgMemberSchema>;

/**
 * An envelope rather than a bare array, and unpaginated.
 *
 * `orgMembershipListSchema` argues the envelope: a top-level object has somewhere
 * to put a later addition, and the one this list will want is pagination. It is not
 * paginated now because the target business is an owner plus a bookkeeper (spec
 * §1), so the list is a handful of rows, and D-21's cursor over `(created_at, id)`
 * is what it grows into rather than something it has to be born with.
 */
export const orgMemberListSchema = z
  .strictObject({
    members: z.array(orgMemberSchema),
  })
  .meta({ id: 'OrgMemberList', description: 'Everyone who belongs to this organization.' });

export type OrgMemberList = z.infer<typeof orgMemberListSchema>;

/**
 * A role this org may hand to a member.
 *
 * `isSystem` distinguishes the six seeded roles from the custom roles v2 adds. It
 * is reported rather than filtered on, because a client rendering a picker needs to
 * know which entries it may not offer to edit.
 */
export const assignableRoleSchema = z
  .strictObject({
    id: z.uuid(),
    code: z.string(),
    name: z.string(),
    description: z.string(),
    isSystem: z.boolean(),
  })
  .meta({ id: 'AssignableRole', description: 'A role that may be granted in this organization.' });

export type AssignableRole = z.infer<typeof assignableRoleSchema>;

export const assignableRoleListSchema = z
  .strictObject({
    roles: z.array(assignableRoleSchema),
  })
  .meta({
    id: 'AssignableRoleList',
    description:
      'The roles an invitation or a re-role may name. Reading this takes `roles.read` and not ' +
      '`members.read`: the catalog is a different subject from the people who hold entries in it.',
  });

export type AssignableRoleList = z.infer<typeof assignableRoleListSchema>;

/**
 * The four states an invitation can be read in.
 *
 * `expired` is derived from the clock on every read rather than stored, because a
 * stored one would be wrong between the moment an invite lapses and whatever job
 * noticed — and there is no such job. The other three are stored, as the timestamps
 * that caused them.
 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * An invitation as the API reports it. **The token is deliberately absent.**
 *
 * The token is a credential: it authorizes joining the org on its own, subject only
 * to the accepting user's address matching. It exists in plaintext for the length of
 * one send and is stored only as a hash, the way a session token is (`tokens.ts`),
 * so there is nothing here to return — and an endpoint that echoed it would make
 * every `members.read` holder able to accept every outstanding invitation.
 *
 * `orgId` is present, where `contactSchema` and `accountSchema` deliberately omit
 * it. An invitation is the one resource whose whole purpose is to be carried out of
 * its org: the accept call names the org because the caller is not yet scoped to it
 * (see `acceptInviteRequestSchema` in the module), so the field is load-bearing here
 * rather than redundant.
 */
export const invitationSchema = z
  .strictObject({
    id: z.uuid(),
    orgId: z.uuid(),
    email: z.email(),
    roleId: z.uuid(),
    roleCode: z.string(),
    status: z.enum(INVITATION_STATUSES),
    invitedByUserId: z.uuid().nullable(),
    acceptedByUserId: z.uuid().nullable(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .meta({
    id: 'Invitation',
    description:
      'An outstanding or settled invitation. The token is never returned — it is a credential, ' +
      'held only as a hash after the message is sent.',
  });

export type Invitation = z.infer<typeof invitationSchema>;

export const invitationListSchema = z
  .strictObject({
    invites: z.array(invitationSchema),
  })
  .meta({
    id: 'InvitationList',
    description: 'Every invitation this organization has issued, in whatever state it reached.',
  });

export type InvitationList = z.infer<typeof invitationListSchema>;

/**
 * The invitation, plus whether the message actually left.
 *
 * A field and not an error, because the send happens after the commit and must
 * never fail the write (`invite-email.ts`). `false` means the row exists and nobody
 * was told, which is a state a client can act on — say so, offer to reissue. The two
 * alternatives are both worse: failing a request whose effect is already durable, or
 * reporting success for an invitation nobody will ever see.
 */
export const issuedInvitationSchema = z
  .strictObject({
    invitation: invitationSchema,
    emailDelivered: z.boolean().meta({
      description:
        'False means the invitation exists and the message did not go out. Reissue rather than ' +
        'assume — the invitation is valid either way, but nobody has the link.',
    }),
  })
  .meta({
    id: 'IssuedInvitation',
    description: 'A newly created invitation and its send outcome.',
  });

export type IssuedInvitation = z.infer<typeof issuedInvitationSchema>;

/**
 * What acceptance produces: a membership, in the org the invite named.
 *
 * `joined: false` is the caller who was already a member. The invite is consumed and
 * the existing membership returned unchanged, which is neither an error nor a
 * re-role — an invitation issued as Read-only must not be a way to demote an Owner
 * who clicked it.
 */
export const acceptedInvitationSchema = z
  .strictObject({
    orgId: z.uuid(),
    userId: z.uuid(),
    roleId: z.uuid(),
    roleCode: z.string(),
    joined: z.boolean().meta({
      description:
        'False when the caller was already a member and the invitation was only consumed. Their ' +
        'existing role is returned; an invitation never changes one.',
    }),
  })
  .meta({
    id: 'AcceptedInvitation',
    description: 'The membership an accepted invitation resolved to.',
  });

export type AcceptedInvitation = z.infer<typeof acceptedInvitationSchema>;
