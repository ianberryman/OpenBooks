import { z } from 'zod';

/**
 * The request shapes this module takes, parsed at the *service* boundary.
 *
 * Spec §12 treats agent and integrator input as untrusted, and spec §2.4 makes the
 * service layer the one place a capability is implemented. Those together mean
 * validation cannot live in the route: OB-045's HTTP handlers, M5's MCP tools, and
 * M6's workflow engine all reach these services, and only one of them will have a
 * Fastify schema in front of it.
 *
 * ## Why the schemas are here and not in `@openbooks/shared-types`
 *
 * Every other module's request schemas live in shared-types because they are the
 * *wire* contract and the OpenAPI artifact is generated from them. This ticket
 * ships no routes — transport is OB-045 — so a schema in shared-types would be a
 * published contract for an endpoint that does not exist, and the drift gate
 * (`yarn spec:check`) could not check it against anything. These move to
 * shared-types with the routes that need them.
 */

/**
 * `users.email` and `org_invites.email` are both `VARCHAR(320)` — the practical
 * maximum for an address.
 */
const MAX_EMAIL_LENGTH = 320;

/**
 * Deliberately loose, and the same pattern `auth.service.ts` uses.
 *
 * It checks that a value is shaped like an address, not that it is deliverable:
 * RFC 5322 permits far more than any regex written for it, and the strict-looking
 * patterns in circulation reject valid addresses. Deliverability is settled by the
 * invite arriving — which is the one flow in the system that actually finds out.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Lowercased and trimmed, for the reason `auth.service.ts` normalizes: `users.email`
 * collates `utf8mb4_0900_ai_ci`, so the database already treats `A@b.test` and
 * `a@b.test` as one address, and normalizing means the *stored* value agrees with
 * that rather than depending on it. It matters more here than there — the accept
 * path compares an invited address against a registered one, and a comparison in
 * application code has no collation to fall back on.
 */
const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAX_EMAIL_LENGTH)
  .regex(EMAIL_PATTERN, { error: 'must be an email address' });

export const inviteMemberRequestSchema = z.strictObject({
  email: emailSchema,
  roleId: z.uuid(),
});

export type InviteMemberRequest = z.infer<typeof inviteMemberRequestSchema>;

export const changeMemberRoleRequestSchema = z.strictObject({
  userId: z.uuid(),
  roleId: z.uuid(),
});

export type ChangeMemberRoleRequest = z.infer<typeof changeMemberRoleRequestSchema>;

export const removeMemberRequestSchema = z.strictObject({
  userId: z.uuid(),
});

export type RemoveMemberRequest = z.infer<typeof removeMemberRequestSchema>;

export const revokeInviteRequestSchema = z.strictObject({
  inviteId: z.uuid(),
});

export type RevokeInviteRequest = z.infer<typeof revokeInviteRequestSchema>;

/**
 * The accept request, and the one place in this module an org arrives as a
 * parameter.
 *
 * Spec §4 puts `orgId` in the request context and never in a signature, and every
 * other operation here obeys that. Acceptance cannot: the caller is by definition
 * not yet a member of the org they are joining, so their context is scoped to some
 * *other* org or to none, and `org_invites` is a tenant table that only
 * `tenantDb(orgId)` can reach. The alternative — finding the invite by an unscoped
 * read of `token_hash` across every tenant — is the shape OB-013 exists to make
 * impossible, and it would be a genuinely unscoped query on a tenant table rather
 * than a scoped one whose scope came from an untrusted place.
 *
 * So the org travels with the token, in the same link, and is validated the way
 * `src/db/org-scope.ts` requires of a client-supplied org: through
 * `tryUuidToBuffer`, so a malformed one, one that names another tenant's invite,
 * and one that names nothing are a single indistinguishable 404 (A7). The org id
 * is not a secret and grants nothing on its own; the token is the credential.
 *
 * Neither field is validated as a `uuid()`/length here beyond shape, deliberately:
 * a token that is the wrong length must fail as a miss, not as a `400` that tells
 * the holder their guess was malformed.
 */
export const acceptInviteRequestSchema = z.strictObject({
  orgId: z.string(),
  token: z.string(),
});

export type AcceptInviteRequest = z.infer<typeof acceptInviteRequestSchema>;
