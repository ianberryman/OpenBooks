import type { ActorType, InvocationMode } from '@openbooks/plugin-api';

import { UNAUTHENTICATED_ID } from '../../context';
import { UnauthenticatedError } from '../../errors';
import { resolveMembership } from '../permissions';
import { selectDefaultMemberOrgId } from '../orgs';
import type { CookieCarrier } from './cookie';
import { readSessionToken } from './cookie';
import type { SessionRow } from './auth.repository';
import { selectSessionByTokenHash, shouldTouchLastSeen, touchLastSeen } from './auth.repository';
import { sessionTokenHash } from './tokens';

/**
 * Turns a request's session cookie into a request context (OB-015 filling OB-022's
 * `IdentityResolver` seam).
 *
 * ## Why the type is declared here rather than imported
 *
 * `src/transport/context.ts` exports `RequestIdentity` and `IdentityResolver`, and this
 * file cannot import either: `.dependency-cruiser.cjs`'s
 * `services-do-not-import-transport` forbids `src/modules/` → `src/transport/`, and
 * correctly — a service coupled to HTTP is a service the MCP surface (M5) and the
 * workflow engine (M6) cannot call. `ResolvedIdentity` below is structurally identical
 * to `RequestIdentity`, so `buildApp({ resolveIdentity: resolveSessionIdentity })`
 * typechecks at the entrypoint, which is the one layer allowed to see both. The
 * duplication is the cost of the boundary and is noted in the OB-015 report; the fields
 * it names are all from `@openbooks/plugin-api`, which both sides do share.
 */
export interface ResolvedIdentity {
  readonly orgId: string;
  /** Null for automation and agent callers not acting as an org member. */
  readonly userId: string | null;
  readonly roleId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  /** Absent means unrecorded. plugin-api is explicit that it must not default. */
  readonly invocationMode?: InvocationMode;
}

/**
 * Resolves the identity behind a session cookie.
 *
 * ## `null` versus `UnauthenticatedError`
 *
 * OB-022's contract makes the distinction "no credentials" (legal, returns `null`) versus
 * "credentials found and rejected" (throws, becomes a `401`). Which side each failure
 * falls on is a decision this file has to make, and getting it wrong the obvious way
 * breaks something important: the hook runs for *every* route, so a resolver that throws
 * for any unusable cookie makes `POST /v1/auth/login` return `401` to a user whose
 * session merely expired — locking them out of the endpoint that fixes it, until they
 * clear cookies by hand. That is a worse failure than anything the strict reading buys.
 *
 * So the line is drawn at whether the credential ended by *design*:
 *
 *  - **No cookie, or an empty one** — `null`. Nothing was presented. An empty value is
 *    what a browser may echo briefly after `clearedSessionCookie`.
 *  - **Expired** — `null`. Sessions are meant to expire; a browser holding one a day too
 *    long is not an event, and the user's next act is to log in again.
 *  - **Names no session at all** — throws. Nothing this system issued produces a
 *    64-character digest matching no row: it is a forged, mangled, or foreign-deployment
 *    cookie, and spec §14's open item on security-event logging is about exactly this.
 *  - **Revoked** — throws. Someone logged out and the token came back. That is a replay
 *    of a credential whose end was affirmative, and it is worth telling apart from
 *    ordinary expiry.
 *  - **User deactivated** — throws. A live session against an account that has been
 *    turned off must stop working immediately, which is the property ROADMAP D-03 chose
 *    server-side sessions for.
 *
 * Both outcomes deny access. The choice only decides whether the request continues in the
 * pre-auth scope or is refused outright, and what an operator sees in the log.
 *
 * ## Why the org is re-derived on every request and never read as authority
 *
 * `sessions.active_org_id` is a hint. Migration `0001_tenancy` explains why it is not a
 * foreign key into `org_members` (MySQL will not accept the composite key with
 * `ON DELETE SET NULL`, because that nulls `user_id` too) and, more to the point, why
 * belt-and-braces there would not have mattered: a role changed mid-session must take
 * effect on the next request, so `org_members` has to be re-resolved every time
 * regardless. That re-resolution is `resolveMembership`, called below, and it is the only
 * thing that decides the `roleId` this request runs with. The stored column contributes a
 * preference and nothing else.
 *
 * A hint naming an org the user has since left is not an error. It degrades to the
 * default membership, which is what a client would show them anyway. Nothing is written
 * back — the correction is recomputed per request rather than persisted, so two
 * concurrent requests cannot race to store different answers, and the total ordering in
 * `selectDefaultMemberOrgId` is what makes them agree.
 *
 * ## A valid session with no org
 *
 * A user removed from their last org still has a session. There is no org to scope them
 * to and `RequestContext` requires one, so the identity names the pre-auth sentinel from
 * `src/context/` while carrying a real `userId`. `isAuthenticatedContext` is then false —
 * every tenant route refuses them — and `me()` still works, because it gates on `userId`.
 * That is the state that motivated moving the sentinel out of transport.
 */
export async function resolveSessionIdentity(
  request: CookieCarrier,
): Promise<ResolvedIdentity | null> {
  const token = readSessionToken(request);
  if (token === undefined) return null;

  const session = await selectSessionByTokenHash(sessionTokenHash(token));
  if (session === undefined) throw new UnauthenticatedError();
  if (session.revokedAt !== null) throw new UnauthenticatedError();
  if (!session.user.isActive) throw new UnauthenticatedError();

  // The application clock decides expiry, because the application clock wrote
  // `expires_at`. Comparing an app-written timestamp against MySQL's `NOW()` would put
  // two clocks on one question and make the session length depend on their skew.
  const now = new Date();
  if (session.expiresAt.getTime() <= now.getTime()) return null;

  if (shouldTouchLastSeen(session, now)) await touchLastSeen(session.id, now);

  return identityFor(session, await resolveScope(session));
}

interface Scope {
  readonly orgId: string;
  readonly roleId: string;
}

/**
 * The org and role this request runs in: the session's hint if it still holds, otherwise
 * the user's default membership, otherwise no scope at all.
 */
async function resolveScope(session: SessionRow): Promise<Scope | null> {
  const { userId, activeOrgId } = session;

  if (activeOrgId !== null) {
    const hinted = await resolveMembership(userId, activeOrgId);
    if (hinted.isMember) return { orgId: activeOrgId, roleId: hinted.roleId };
  }

  const fallback = await selectDefaultMemberOrgId(userId);
  if (fallback === undefined) return null;

  const membership = await resolveMembership(userId, fallback);
  // `selectDefaultMemberOrgId` reads `org_members` and `resolveMembership` re-reads it
  // with the role-visibility predicate, so a membership pointing at a role invisible from
  // its own org lands here. Fail closed: no scope rather than a scope with no role.
  return membership.isMember ? { orgId: fallback, roleId: membership.roleId } : null;
}

/**
 * `invocationMode` is deliberately absent, not `'interactive'`.
 *
 * plugin-api's `ActorProvenance` says not to default it, and the schema agrees in a way
 * that bites: `chk_journals_invocation_mode` requires the column exactly for
 * `actor_type = 'agent'` and forbids it otherwise, so a user context carrying an
 * invocation mode would make every posting it attempts fail a `CHECK` constraint.
 */
function identityFor(session: SessionRow, scope: Scope | null): ResolvedIdentity {
  return {
    orgId: scope?.orgId ?? UNAUTHENTICATED_ID,
    userId: session.userId,
    roleId: scope?.roleId ?? UNAUTHENTICATED_ID,
    actorType: 'user',
    actorId: session.userId,
  };
}
