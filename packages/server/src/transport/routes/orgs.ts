import {
  createOrgRequestSchema,
  orgMembershipListSchema,
  orgMembershipSchema,
  switchActiveOrgRequestSchema,
} from '@openbooks/shared-types';
import type { OrgMembershipList } from '@openbooks/shared-types';

import { me, readSessionToken, switchActiveOrg } from '../../modules/auth';
import { withGlobalIdempotency } from '../../modules/idempotency';
import type { OrgMembership } from '../../modules/orgs';
import { createOrg } from '../../modules/orgs';
import { requireIdempotencyKey } from '../idempotency';
import type { App } from '../types';
import { ERROR_RESPONSES, idempotencyKeyHeaderSchema, idempotentBody, wireList } from './support';

/**
 * `/v1/orgs` — create, list memberships, and switch the active one (spec §5).
 *
 * ## Why the list route calls `me()` and not `listMemberships()`
 *
 * `listMemberships(userId)` takes a user id and makes no authority check of its own —
 * it is a query the auth service composes, not an operation. A route calling it would
 * have to read `context.userId`, decide that `null` means `401`, and raise it. That
 * decision is exactly what spec §2.4 keeps out of transport, and putting it here
 * would make this the one place in the system where a route answers an authorization
 * question.
 *
 * `me()` asks the same thing and owns the gate: it reads `userId` from context and
 * throws `UnauthenticatedError` itself, deliberately keyed on `userId` rather than on
 * `isAuthenticatedContext` so a user with no org still gets an answer. So this route
 * projects one field of an existing operation's result. The cost is one extra
 * `users` read; the benefit is that no route in this directory contains an
 * authorization decision.
 *
 * ## `createOrg` has no permission, and there is none that would fit
 *
 * Every permission in the catalog is a statement about authority *within* an org, and
 * this operation runs before the org it would be checked against exists. The only
 * gate is that the caller is a real user, which `createOrg` enforces by reading the
 * context — an org created on behalf of somebody else is not expressible in its
 * signature.
 *
 * ## Both writes claim in the org-less namespace (OB-028)
 *
 * `withGlobalIdempotency`, for two different reasons that arrive at the same place.
 * `createOrg` runs before the org its claim would belong to exists, and a claim
 * recorded against the caller's *current* org would make the guarantee depend on
 * which org they happened to be scoped to when they submitted the form.
 * `switchActiveOrg` would record the claim against the org being left, so a client
 * that switched away and retried the switch would find its own key in an org it no
 * longer reads. Neither is a tenant fact; both belong in the namespace `claim_scope`
 * exists for (migration `0003`).
 *
 * The one this closes in practice is a double-submitted org-creation form, which
 * before this ticket made two orgs.
 */

const TAG = 'orgs';

export function registerOrgRoutes(app: App): void {
  /**
   * 201 and no `Location`. There is no `GET /v1/orgs/{orgId}` to point at, and
   * deliberately so: an org is reached by *switching* to it, because a route that
   * returned any org by id would need an A7 answer for an org the caller is not a
   * member of, and `POST /v1/orgs/active` already is that answer.
   */
  app.post(
    '/v1/orgs',
    {
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'createOrg',
        summary: 'Create an organization',
        description:
          'Creates an organization with the calling user as its Owner. The slug is derived from ' +
          'the name and collisions are disambiguated silently, so no collision is ever reported.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: createOrgRequestSchema,
        response: { 201: orgMembershipSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withGlobalIdempotency(
        { endpoint: 'createOrg', request: request.body, successStatus: 201 },
        () =>
          createOrg({
            name: request.body.name,
            ...(request.body.fiscalYearStartMonth === undefined
              ? {}
              : { fiscalYearStartMonth: request.body.fiscalYearStartMonth }),
          }),
      );

      return reply.status(result.status).send(idempotentBody<OrgMembership>(result));
    },
  );

  app.get(
    '/v1/orgs',
    {
      schema: {
        operationId: 'listOrgMemberships',
        summary: 'Every organization the caller is a member of',
        description:
          'The org switcher’s menu. Always the full list with the role held in each, because ' +
          'one login may be Owner of its own books and Read-only on a client’s.',
        tags: [TAG],
        response: { 200: orgMembershipListSchema, ...ERROR_RESPONSES },
      },
    },
    async (): Promise<OrgMembershipList> => {
      const identity = await me();
      return { memberships: wireList(identity.memberships) };
    },
  );

  /**
   * A `POST` to a singleton sub-resource rather than a `PUT /v1/orgs/{orgId}/active`,
   * because the thing being changed belongs to the *session* and not to the org: two
   * browsers logged in as the same user have two active orgs, and a path rooted at the
   * org would suggest otherwise.
   *
   * 200 and not 201: nothing is created. The body is the membership just resolved —
   * the role held in the *new* org, never one carried across the switch, which is the
   * whole failure mode an accountant moving from their own books to a client's needs
   * avoided.
   */
  app.post(
    '/v1/orgs/active',
    {
      onRequest: requireIdempotencyKey,
      schema: {
        operationId: 'switchActiveOrg',
        summary: 'Switch the session’s active organization',
        description:
          'Re-resolves the caller’s membership and points the session at the new org. An org ' +
          'the caller is not a member of and an org that does not exist both answer `not_found`.',
        tags: [TAG],
        headers: idempotencyKeyHeaderSchema,
        body: switchActiveOrgRequestSchema,
        response: { 200: orgMembershipSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const result = await withGlobalIdempotency(
        { endpoint: 'switchActiveOrg', request: request.body, successStatus: 200 },
        // `?? ''` for the same reason as logout: the service decides what an unusable
        // credential means. With no cookie the identity resolver left `userId` null and
        // `switchActiveOrg` refuses on that line before the token is looked at.
        () => switchActiveOrg(readSessionToken(request) ?? '', request.body.orgId),
      );

      return reply.status(result.status).send(idempotentBody<OrgMembership>(result));
    },
  );
}
