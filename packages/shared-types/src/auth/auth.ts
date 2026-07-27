import { z } from 'zod';

import { createOrgRequestSchema, orgMembershipSchema } from '../orgs';

/**
 * The session-authentication wire contract (OB-023; spec §5).
 *
 * ## Why the credential fields carry no format rules
 *
 * `email`, `password`, and `displayName` are plain strings here, and that is a
 * decision rather than an omission. `src/modules/auth/` owns every rule about them
 * and each rule exists for a reason a schema cannot see:
 *
 *  - The email pattern there is *deliberately loose*, because the strict-looking
 *    regexes in circulation reject valid addresses (quoted local parts, new TLDs).
 *    A `z.email()` here would be a second, stricter opinion, and the direction of
 *    that error is the bad one: it would refuse addresses the server accepts, at
 *    the edge, where the message cannot explain itself.
 *  - The password bounds are a DoS control and a NIST-derived floor, tuned against
 *    the Argon2 cost parameters. Restating the numbers would make the artifact
 *    disagree with the server the first time either is retuned, and the safe
 *    direction — schema looser than service — is what this is.
 *
 * So the objects are `strictObject`s (an unknown key is refused, which is shape and
 * not policy) and every value rule is answered by the service as a
 * `validation_failed` naming the field. Requests that fail are refused either way;
 * what this buys is one authority per rule.
 *
 * ## The session cookie is not in any schema here
 *
 * Register and login set an `HttpOnly` session cookie and return no token. Putting
 * the token in a response body would make it readable by script, which is the one
 * property `HttpOnly` exists to provide (ROADMAP D-03). `SESSION_COOKIE_NAME` and
 * the cookie's attributes live in `src/modules/auth/cookie.ts`.
 */

/**
 * The signed-in person. Distinct from `OrgMembership`, which is what they may *do*
 * and where.
 */
export const authenticatedUserSchema = z
  .strictObject({
    id: z.uuid(),
    email: z.string(),
    displayName: z.string(),
  })
  .meta({ id: 'AuthenticatedUser', description: 'The signed-in user.' });

/**
 * Who the caller is, and their org menu.
 *
 * `memberships` is always the full list rather than the active org alone: spec §5's
 * motivating case is one login that is Owner of its own books and Read-only on a
 * client's, so a client that only ever learned about the current org could not
 * render a switcher at all.
 *
 * `activeOrgId` is nullable because a user who has been removed from their last org
 * is a real state — they have a valid session and no org scope. Every tenant route
 * refuses them and this response is what lets a client say so, instead of bouncing
 * them to a login form that will succeed and change nothing.
 */
export const identityResponseSchema = z
  .strictObject({
    user: authenticatedUserSchema,
    memberships: z.array(orgMembershipSchema),
    activeOrgId: z.uuid().nullable(),
  })
  .meta({
    id: 'Identity',
    description:
      'The caller, every organization they are a member of, and which one this session is ' +
      'currently scoped to. `activeOrgId` is null for a user who is a member of nothing.',
  });

export type IdentityResponse = z.infer<typeof identityResponseSchema>;

/**
 * The identity plus what the caller may do in the active org (OB-030, ROADMAP D-25).
 *
 * ## Advisory, and stated in the contract so nobody has to guess
 *
 * `permissions` exists so a screen can hide an action the caller cannot take — an
 * interface offering actions that always fail is not a usable one. It is **not** an
 * authorization answer and no client may treat it as one: enforcement is
 * `requirePermission` in the service layer, on every operation, regardless of what
 * this array said (spec §2.4, §5). D-25 states it as a decision precisely because the
 * failure mode is predictable — a UI that gates well enough becomes a UI someone
 * trusts as the gate.
 *
 * Empty for a caller with no active org, which is the same set an unauthenticated
 * caller would get and deliberately so: neither may do anything in any org.
 *
 * ## Why a separate schema from `Identity`
 *
 * `Identity` is also the register and login response, and neither of those has a
 * permission set to report: register's caller is being invented, and login answers
 * before any org scope is established. A single schema would need the field optional,
 * and an optional advisory permission set is one a client cannot tell apart from an
 * empty one — which is the difference between "you may do nothing" and "nobody said".
 *
 * `permissions` is `string[]` rather than an enum of the 48 codes because the catalog
 * is the server's (`src/modules/permissions/catalog.ts`) and is held to the seeded
 * table by a drift test there. Restating it here would be a second authority on which
 * codes exist, and the direction it would drift is a client refusing to parse a
 * response the server considers valid.
 */
export const callerIdentityResponseSchema = identityResponseSchema
  .extend({
    permissions: z.array(z.string()),
  })
  .meta({
    id: 'CallerIdentity',
    description:
      'The caller, their organizations, the active one, and the permission codes their role ' +
      'carries there. `permissions` is advisory — it is what a screen hides affordances with, ' +
      'never what authorizes an operation, which every service checks for itself.',
  });

export type CallerIdentityResponse = z.infer<typeof callerIdentityResponseSchema>;

/**
 * `org` is required, because a user with no membership can do nothing in M1: every
 * permission in the catalog is a statement about authority *within* an org. The
 * other way an account comes into existence — accepting an invite to an org that
 * already exists — is a second entry point (M2) rather than this one with the org
 * made optional.
 */
export const registerRequestSchema = z
  .strictObject({
    email: z.string(),
    password: z.string(),
    displayName: z.string(),
    org: createOrgRequestSchema,
  })
  .meta({
    id: 'RegisterRequest',
    description:
      'Creates a user, their first organization, an Owner membership, and a session — ' +
      'atomically. Reachable without credentials.',
  });

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Every failure of this operation looks the same and costs the same: an unknown
 * address is verified against a decoy hash rather than short-circuited, because a
 * response that returns in a millisecond instead of forty is a working
 * user-enumeration oracle regardless of what the body says (`login` in
 * `auth.service.ts`).
 */
export const loginRequestSchema = z
  .strictObject({
    email: z.string(),
    password: z.string(),
  })
  .meta({
    id: 'LoginRequest',
    description:
      'Exchanges a password for a session cookie. Reachable without credentials. Every ' +
      'failure answers `unauthenticated` with no detail — a wrong password and an unknown ' +
      'address are indistinguishable by design.',
  });

export type LoginRequest = z.infer<typeof loginRequestSchema>;
