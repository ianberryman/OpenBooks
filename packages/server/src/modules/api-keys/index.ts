/**
 * API-key management (OB-099; ROADMAP D-55, D-61).
 *
 * The `api_keys` table has existed, unused, since `0001_tenancy` — spec §7 lists it
 * under tenancy so it would not need altering a populated schema later. This wave
 * gives it a write path: issue, list, revoke, and the identity resolver that lets a
 * key actually authenticate a request.
 *
 * Read `api-keys.service.ts` for why a key is bound to its own `role_id` rather
 * than the issuer's, `api-keys.repository.ts` for the third copy of the
 * `roles.org_id = ? OR roles.org_id IS NULL` predicate and why it is not yet
 * hoisted, and `modules/auth/api-key-identity.ts` for the resolver
 * (`IdentityResolver`'s module-side contract, `ResolvedIdentity`) that turns a
 * presented key into a request scoped to the key's org and role with no user
 * behind it.
 *
 * No route lives here. OB-104 owns ids and the HTTP surface; these functions are
 * equally reachable from an MCP tool (M5) or the workflow engine (M6), because none
 * of them touches a request or a reply.
 */
export type { ListApiKeysQuery } from './api-keys.service';
export { createApiKey, listApiKeys, revokeApiKey } from './api-keys.service';
