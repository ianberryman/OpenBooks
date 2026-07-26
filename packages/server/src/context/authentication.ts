import type { RequestContext } from './context';

/**
 * The scope a request occupies before authentication has run, and the test for
 * whether it is still in it.
 *
 * ## Why a sentinel org exists at all
 *
 * `RequestContext` (= plugin-api's `OperationContext`) makes `orgId`, `roleId`,
 * `actorType`, and `actorId` non-optional, deliberately: spec §4's guarantee is
 * that scope cannot be absent, and a context whose `orgId` might be `undefined`
 * pushes a null check into every tenant query, which is precisely the hole the
 * requirement closes. So there is no such thing as a context without an org, and
 * the pre-auth scope has to name one.
 *
 * ## Why the nil UUID is the safe thing to name
 *
 * `00000000-0000-0000-0000-000000000000` is well-formed, so nothing downstream
 * has to handle a malformed id, and it cannot name a real row: every `orgs.id`,
 * `roles.id`, and `users.id` in the system is a version-4 UUID (the seeded system
 * roles in migration `0001` are `…-4000-8000-…`), and the nil UUID's version
 * nibble is `0`. A query that somehow ran in this scope therefore returns zero
 * rows and, through `assertFound`, the one response A7 permits — a `not_found`
 * carrying no identifier. It fails closed.
 *
 * It is also not a capability. `tenantDb` takes an `OrgId`, which is a `Buffer`,
 * while a context's `orgId` is a string; reaching the database from this scope
 * requires an explicit conversion at the call site, which is visible in review
 * rather than implicit.
 *
 * ## Why this lives in `src/context/` and not in `src/transport/`
 *
 * It was in `src/transport/context.ts`, which put a security constant on the far
 * side of a boundary rule: `.dependency-cruiser.cjs`'s
 * `services-do-not-import-transport` makes `src/modules/` → `src/transport/` a
 * build failure, and correctly so. Two consumers needed it from the wrong side.
 *
 *  - OB-016's `requirePermission` wants to answer a request that presented no
 *    credentials with `401` rather than `403`, and could not ask.
 *  - OB-015's session identity resolver *produces* this scope: a session that is
 *    valid but resolves to no org membership — the user was removed from their
 *    only org — is an authenticated user with no org scope, and the resolver has
 *    to name an org for the context it returns.
 *
 * The fix is not to restate the constant in a second file. Both layers may import
 * `src/context/`, so it lives here and `src/transport/context.ts` re-exports it
 * for the transport surface OB-022 published.
 */
export const UNAUTHENTICATED_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Whether the context carries an org scope that came from real credentials.
 *
 * Keyed on `orgId` rather than on `userId`, because the two ask different
 * questions and both are needed. This one is "may a tenant query run", which an
 * API key (M5) satisfies with a null `userId`; "is there a human behind this
 * request" is `context.userId !== null` and is what the session services in
 * `src/modules/auth/` check.
 */
export function isAuthenticatedContext(context: RequestContext): boolean {
  return context.orgId !== UNAUTHENTICATED_ID;
}
