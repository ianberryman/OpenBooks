import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from 'kysely';

import type { DB } from './generated';

/**
 * The transaction in scope for the current async execution, if any.
 *
 * ## Why this exists
 *
 * `tenantDb(orgId)` builds a wrapper over the connection pool. `TenantDatabase`
 * already joins an outer transaction when it *holds* one — but it cannot discover
 * one it does not hold, and nothing threaded a handle through. So two services
 * that each open a transaction during one request got two transactions on two
 * connections, and the composition silently failed:
 *
 *   withIdempotency(spec, () => postJournal(input, ctx))
 *
 * compiles, reads correctly, and is wrong. The idempotency claim and the posting
 * land in separate transactions, so a rollback of one leaves the other committed —
 * which defeats the entire point of claiming inside the write's transaction and
 * breaks acceptance A8 ("duplicate idempotency key yields exactly one journal") at
 * the seam between two tickets that each pass their own tests.
 *
 * The alternative was to thread a transaction parameter through every service
 * signature. That makes the transaction a visible part of every contract, which is
 * exactly what spec §4 rejects for `orgId` and for the same reason: a parameter
 * that must be passed correctly at every call site eventually is not.
 *
 * ## Scope and safety
 *
 * `AsyncLocalStorage` is per async execution, so a concurrent request cannot see
 * another's transaction — this is the same mechanism `src/context/` uses for the
 * request context, and the same isolation argument applies.
 *
 * A consequence worth knowing: once a transaction is open, every `tenantDb()` in
 * that async scope joins it, including one built for a *different* org. That is
 * correct for a request (one org, one unit of work) and wrong for a background job
 * that re-scopes per row across many orgs (spec §4) — such a job must not open an
 * outer transaction, or it accumulates every row into one. There is no such job in
 * M1; when M5's worker adds one, it re-scopes per row *outside* any transaction and
 * opens its own within each scope.
 */
const store = new AsyncLocalStorage<Transaction<DB>>();

export function ambientTransaction(): Transaction<DB> | undefined {
  return store.getStore();
}

export function runInTransactionScope<R>(
  transaction: Transaction<DB>,
  body: () => Promise<R>,
): Promise<R> {
  return store.run(transaction, body);
}

export function hasAmbientTransaction(): boolean {
  return store.getStore() !== undefined;
}
