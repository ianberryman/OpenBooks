import type { Kysely } from 'kysely';

import { rawDb } from './client';
import type { DB } from './generated';
import { TenantDatabase, type OrgId } from './tenant';
import { ambientTransaction } from './transaction-scope';

/**
 * The public database surface. Two functions and some types — nothing else.
 *
 * Spec §4 requires that the unsafe path not exist. `src/db/client.ts` holds the
 * raw handle and is deliberately not re-exported here, and
 * `.dependency-cruiser.cjs` makes importing it from outside `src/db/` a build
 * failure. So the only names service code can reach are the two below.
 */

/**
 * Org-scoped access to tenant tables. Every query is filtered to `orgId` before
 * the caller sees it, and only tenant tables are addressable.
 *
 * The org comes from request-scoped context (spec §4: "never as a loose
 * parameter"), so the intended call is `tenantDb(requestContext().orgId)` at the
 * top of a service method rather than threading an org through signatures.
 */
export function tenantDb(orgId: OrgId): TenantDatabase {
  // An ambient transaction wins over the pool. Without this, a service called
  // inside another service's transaction would silently get its own connection —
  // see `transaction-scope.ts` for the composition this exists to make correct.
  return new TenantDatabase(ambientTransaction() ?? rawDb(), orgId);
}

/**
 * Access to the tables that are not org-scoped: `users`, `permissions`,
 * `role_permissions`, `sessions`, `orgs`, and `roles`.
 *
 * This is the acknowledged limit of the guarantee (ROADMAP D-01). These tables
 * have no `org_id` to filter on — a user exists across orgs, permissions are a
 * fixed global catalog — so there is nothing for a wrapper to inject. The surface
 * is kept small and the tables on it are all ones where "which org" is not a
 * meaningful question.
 *
 * Two of them need care, and both are called out where they are used:
 *
 *  - `roles` carries a nullable `org_id`, where NULL means a shared system role.
 *    Queries against it need `org_id = ? OR org_id IS NULL`, never a bare
 *    equality, or every system role disappears. See `tenant-tables.ts`.
 *  - `sessions.active_org_id` is a preference, not an authorization. It must be
 *    re-validated against `org_members` on every request; migration `0001`
 *    explains why it cannot be a foreign key.
 */
export function systemDb(): Kysely<DB> {
  // Joins an ambient transaction for the same reason tenantDb does, and the
  // asymmetry was a real bug before this line existed: registration writes `users`
  // and `orgs` (neither org-scoped, so both reached through here) alongside
  // `org_members` (a tenant table, reached through the wrapper). With only the
  // wrapper transaction-aware, those landed on two connections, so a half-created
  // account could survive a rollback. Both OB-015 and OB-019 hit it independently,
  // which is the signal that the inconsistency was the defect and not their code.
  return ambientTransaction() ?? rawDb();
}

export { initializeDatabase, destroyDatabase, isDatabaseInitialized } from './client';
// UUID ↔ BINARY(16). Exported here rather than left to deep imports because every
// caller that holds an `OrgId` needs it, and a module that cannot find it writes
// its own copy in the wrong byte order — which has already happened twice.
export {
  bufferToUuid,
  isUuid,
  newUuid,
  newUuidBuffer,
  tryUuidToBuffer,
  uuidToBuffer,
} from './uuid';
// The single conversion from a context's UUID-string orgId to the BINARY(16) form
// tenantDb takes. Three modules had written this independently before it was
// hoisted; see org-scope.ts for why its failure is a 500 and not a 400.
export { orgScope } from './org-scope';
// Driver-error predicates. A unique key or a grant is the real guarantee for several
// rules while the application pre-check races it; these turn the losing race into the
// same answer rather than an opaque 500.
export {
  isAccessDeniedError,
  isDuplicateEntryError,
  isMissingParentError,
  isRetryableConcurrencyError,
  isStillReferencedError,
} from './mysql-errors';
// The system-table counterpart of `TenantDatabase.transaction`. Exported because
// `systemDb().transaction()` throws once a transaction is already in scope, which
// OB-028's org-less claims made reachable — see `transaction-scope.ts`.
export { withTransaction, runDetached } from './transaction-scope';
// Keyset pagination (D-21). Exported here beside `tenantDb` because it is only
// usable *with* it: the helper adds a predicate to an already-scoped builder rather
// than building a statement of its own, which is what keeps org scoping applied to
// every page.
export {
  applyKeyset,
  calendarDateKey,
  counterKey,
  instantKey,
  resolvePageLimit,
  textKey,
  toKeysetPage,
  uuidKey,
} from './keyset';
export type { KeysetColumn, KeysetOrdering, KeysetPage } from './keyset';
export { TenantDatabase } from './tenant';
export type { OrgId, TenantInsert, TenantUpdate } from './tenant';
export type { TenantTableName } from './tenant-tables';
export { TENANT_TABLES, isTenantTable } from './tenant-tables';
export type { DatabaseConnectionConfig } from './connection';
export type { DB } from './generated';
