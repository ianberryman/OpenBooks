import type { RequestContext } from '../../context';
import { InternalError, PermissionDeniedError } from '../../errors';
import type { PermissionKey } from './catalog';
import { isUuid, selectMembershipRole, selectRolePermissionKeys } from './permissions.repository';

/**
 * Authorization enforcement (spec §5: "Enforcement via
 * `requirePermission(ctx, 'invoices.write')` **in the service layer only**").
 *
 * Nothing in this file knows about HTTP, and nothing in transport may import it.
 * `RouteDefinition.permission` and `McpToolDefinition.permission` declare which
 * permission an operation needs so the OpenAPI artifact and the MCP manifest can
 * state it; the check itself happens once, in the service the operation calls, so
 * that a second transport cannot arrive with a second (or absent) enforcement
 * point. See `catalog.ts` for why the type lives in a different module from this
 * one, and the OB-016 report for the boundary rule that makes the split
 * enforceable.
 */

/**
 * Per-request memoization of role → permissions.
 *
 * ## Why the cache is keyed by the context object
 *
 * A role's permission set is stable for the duration of one request, and a service
 * method may check several permissions, so resolving per call would mean a query
 * per check. The tempting cache is a module-level `Map<roleId, permissions>`. That
 * cache is wrong, and wrong in a way that has already been reasoned about
 * elsewhere in this codebase: it lives for the life of the *process*, so a member
 * whose role is changed keeps their old permissions until a restart. That is
 * exactly the failure the session design in `0001_tenancy.ts` was built to avoid —
 * "a role changed mid-session would otherwise keep its old permissions until the
 * cookie expired… authorization re-resolves `org_members` on every request already,
 * and has to". A process-lifetime permission cache would reintroduce it one layer
 * down, and worse: a stateless cookie at least expires.
 *
 * A `WeakMap` keyed by the frozen context object gives the entry exactly the
 * context's lifetime. Two consequences fall out for free rather than needing code:
 *
 *  - A new request builds a new context (`createRequestContext`), so it is a new
 *    key and re-resolves. There is no invalidation to remember on a re-role.
 *  - An org switch or a per-row worker re-scope goes through `deriveContext`, which
 *    returns a *new* frozen object, so the derived scope resolves its own role
 *    rather than inheriting the parent's permissions. A cache keyed by
 *    `requestId` would have got this wrong, since a derived context keeps the
 *    parent's request id deliberately.
 *
 * The context is frozen (`context/context.ts`), so the memo cannot be a field on
 * it — which is the reason this is a `WeakMap` and not a lazily-assigned property.
 *
 * ## Why the promise is cached, not the value
 *
 * Concurrent checks — `Promise.all` over two service calls in one request — would
 * otherwise each miss and issue their own query. Caching the in-flight promise
 * makes the second caller await the first one's query. A rejection is evicted, so a
 * transient database error does not poison the rest of the request with a
 * permanently failed lookup.
 */
const permissionsByContext = new WeakMap<RequestContext, Promise<ReadonlySet<PermissionKey>>>();

/**
 * The permissions the context's role carries in the context's org, resolved once
 * per context.
 *
 * Not `async`: it must return the *same* promise object to concurrent callers, and
 * an async function would wrap it in a new one on every call.
 */
export function permissionsForContext(ctx: RequestContext): Promise<ReadonlySet<PermissionKey>> {
  const cached = permissionsByContext.get(ctx);
  if (cached !== undefined) return cached;

  const pending = resolveContextPermissions(ctx).catch((error: unknown) => {
    permissionsByContext.delete(ctx);
    throw error;
  });
  permissionsByContext.set(ctx, pending);
  return pending;
}

async function resolveContextPermissions(ctx: RequestContext): Promise<ReadonlySet<PermissionKey>> {
  // A context is host-built, from a session or an API key, so a `roleId` that is
  // not a UUID is a bug in whoever opened the scope — not a caller error. Failing
  // loudly beats the alternative: MySQL rejects a malformed `UUID_TO_BIN` argument
  // with a driver error, and swallowing it would present as every request in the
  // process being denied for no stated reason.
  if (!isUuid(ctx.roleId)) {
    throw new InternalError(
      'Request context carries a roleId that is not a UUID; the context was built from an ' +
        'untrusted value or the wrong field.',
    );
  }
  if (!isUuid(ctx.orgId)) {
    throw new InternalError(
      'Request context carries an orgId that is not a UUID; the context was built from an ' +
        'untrusted value or the wrong field.',
    );
  }

  return new Set(await selectRolePermissionKeys(ctx.roleId, ctx.orgId));
}

/**
 * Whether the caller holds `permission`. For the rare service that legitimately
 * *branches* on authority rather than requiring it — a list that includes archived
 * rows only for a caller who can write them.
 *
 * Prefer `requirePermission`. A boolean invites `if (!ok) return []`, which turns a
 * missing permission into an empty result the client cannot distinguish from real
 * emptiness.
 */
export async function hasPermission(
  ctx: RequestContext,
  permission: PermissionKey,
): Promise<boolean> {
  return (await permissionsForContext(ctx)).has(permission);
}

/**
 * Throws unless the context's role carries `permission`.
 *
 * Fails closed in every degenerate case, because they are all the same code path: a
 * role id naming no row, a custom role belonging to a different org, a role with an
 * empty bundle, and a role that simply lacks this one permission all resolve to a
 * set that does not contain it.
 *
 * `PermissionDeniedError` takes the permission key and nothing else, deliberately —
 * see the A7 commentary in `src/errors/errors.ts`. The object being acted on is not
 * passed in and there is nowhere to put it: a `403` that can name an object is an
 * existence oracle. This is also why the error is thrown for the caller's *lack of
 * authority* only; a row that belongs to another org never reaches a service, and
 * when one is reached by surrogate id, `assertOrgMatch` throws `NotFoundError`
 * rather than this.
 *
 * ## Open seam: 401 versus 403 for a request that presented no credentials
 *
 * The HTTP transport opens every request in a pre-auth scope whose `orgId` is the
 * nil UUID, and `src/transport/index.ts` states that this check is where such a
 * request should be refused, via its `isAuthenticatedContext`. This module cannot
 * call it: `.dependency-cruiser.cjs`'s `services-do-not-import-transport` makes
 * `src/modules/` → `src/transport/` a build failure, and correctly so — a service
 * that imports transport is a service the MCP surface and the M6 workflow engine
 * cannot call.
 *
 * The behaviour is safe in the meantime rather than merely unspecified: the nil
 * UUID is a well-formed UUID that names no row (every real id is v4), so a pre-auth
 * context resolves to an empty set and every check fails closed. It fails with a
 * `403` where `401` is the more accurate answer. The fix is not to restate the
 * sentinel here, which would put a security constant in two files; it is to move it
 * into `src/context/`, which both layers may import. Neither this ticket nor OB-022
 * owns that module — see the OB-016 report.
 */
export async function requirePermission(
  ctx: RequestContext,
  permission: PermissionKey,
): Promise<void> {
  if (!(await hasPermission(ctx, permission))) {
    throw new PermissionDeniedError(permission);
  }
}

/**
 * The result of asking whether a user is a member of an org.
 *
 * A discriminated union rather than a thrown error, because the caller decides what
 * "not a member" means and only the caller can: OB-015 resolving a session's
 * `active_org_id` hint against a membership that has since been revoked owes the
 * client a `404` (A7 — a `403` would confirm the org exists), while an invite
 * acceptance flow treats the same answer as ordinary control flow. Throwing here
 * would force the second case to catch an error to ask a question.
 */
export type MembershipResolution =
  | { readonly isMember: false }
  | {
      readonly isMember: true;
      readonly roleId: string;
      /** The role's stable `code` (`owner`, `bookkeeper`, …), not its display name. */
      readonly roleCode: string;
      readonly permissions: ReadonlySet<PermissionKey>;
    };

/**
 * The role and permissions a user holds in an org, or a clean non-membership.
 *
 * This is the step that turns a login into a scope: `sessions.active_org_id` is a
 * hint, spec §5 makes `org_members` many-to-many so the same login holds different
 * roles in different orgs, and the role is a property of the *membership*. So there
 * is no such thing as "the user's role" to cache on a session — it has to be
 * resolved per (user, org), which is what this does.
 *
 * Not memoized, and it must not be: it runs *before* a context exists, so there is
 * no request-scoped key to hang a memo on, and the process-wide alternative is the
 * stale-role cache this module refuses on principle. The consequence is one
 * duplicate query per request — this call, then the first `requirePermission`
 * resolving the same bundle through the context memo. Accepted knowingly, because
 * the fix (letting a caller seed the memo) would be a public function that writes
 * arbitrary permissions into a request's authorization state, and no amount of
 * documentation makes that a safe thing to have available.
 *
 * A `userId` or `orgId` that is not a UUID returns a non-membership rather than
 * throwing: unlike a context's `roleId`, the org here can be client-supplied at an
 * org switch, and A7 requires "you are not a member" and "no such org" to be the
 * same answer.
 */
export async function resolveMembership(
  userId: string,
  orgId: string,
): Promise<MembershipResolution> {
  if (!isUuid(userId) || !isUuid(orgId)) return { isMember: false };

  const membership = await selectMembershipRole(userId, orgId);
  if (membership === undefined) return { isMember: false };

  return {
    isMember: true,
    roleId: membership.roleId,
    roleCode: membership.roleCode,
    permissions: new Set(membership.permissions),
  };
}
