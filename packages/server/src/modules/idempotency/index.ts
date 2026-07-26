/**
 * Idempotency (OB-017; spec §12; ROADMAP D-04).
 *
 * Spec §12: "Idempotency keys on every write endpoint, not only the posting API. A
 * retried payment record must not double-post."
 *
 * ## A wrapper, not a parameter
 *
 * No domain service mentions idempotency. `OperationContext` carries
 * `idempotencyKey` and `RouteDefinition.requiresIdempotencyKey` declares the
 * requirement, and this module is what turns the two into behaviour. OB-020's
 * posting service does not import anything from here, does not read
 * `ctx.idempotencyKey`, and has no idea whether the write it is performing is a
 * first attempt or the only attempt — which is the point: idempotency is a property
 * of the *request*, and a service that took it as an argument would have to be
 * trusted to apply it, on every write, forever.
 *
 * The whole surface is one function at the transport boundary:
 *
 * ```ts
 * const result = await withIdempotency(
 *   { endpoint: route.operationId, request: input, successStatus: 201 },
 *   (trx) => ledger.postJournalIn(trx, input, ctx),
 * );
 * reply.status(result.status).send(result.body);
 * ```
 *
 * `result.body` is deep-equal on the first execution and on every replay, so the
 * transport does not branch on `outcome` — it is there for logging and for the
 * `Idempotent-Replayed` response header OB-023 may want, not for control flow.
 *
 * ## The one thing a caller must get right
 *
 * The operation callback receives the transactional, org-scoped handle **and has to
 * use it**. A callback that ignores its parameter and calls `tenantDb(...)` itself
 * opens a second transaction; the claim and the write then commit separately, and
 * every guarantee in `service.ts` evaporates while all these tests still pass.
 *
 * That is a real seam, and it exists because `PostingService.postJournal(input, ctx)`
 * — the plugin-api contract, which this ticket may not change — opens its own
 * transaction internally and has no slot for a caller's. Two ways out, for whoever
 * picks up OB-020 and OB-023:
 *
 *  1. **Preferred.** Give `src/db` ambient transaction propagation, so that
 *     `tenantDb(orgId).transaction(...)` called inside an already-open transaction on
 *     the same request *joins* it — `TenantDatabase.transaction` already does exactly
 *     this when it holds a `Transaction<DB>`, it simply has no way to find one it
 *     does not hold. Then `withIdempotency(spec, () => postJournal(input, ctx))` is
 *     correct as written, the callback parameter becomes optional, and nothing
 *     outside `src/db` needs to know a transaction is in play.
 *  2. Have the ledger module expose a transaction-accepting variant beside its
 *     `PostingService` implementation, as the sketch above assumes. Note that the
 *     variant cannot live in `posting.repository.ts` and be called from transport:
 *     `.dependency-cruiser.cjs`'s `transport-holds-no-business-logic` forbids that
 *     edge, correctly.
 *
 * ## Retention and cleanup
 *
 * `IDEMPOTENCY_RETENTION_MS` is 7 days, argued in `service.ts`. Expiry is enforced on
 * read, so behaviour never depends on when cleanup last ran;
 * `purgeExpiredIdempotencyKeys` only reclaims space and is called per org by M5's
 * worker. An expired key reused with the same body executes again — stated plainly at
 * the line that decides it, because it is the edge case the window is chosen to keep
 * out of reach rather than one the code can eliminate.
 */
export type {
  IdempotencyOptions,
  IdempotencySpec,
  IdempotentOperation,
  IdempotentOutcome,
  IdempotentResult,
  PurgeOptions,
} from './service';
export {
  IDEMPOTENCY_RETENTION_MS,
  purgeExpiredIdempotencyKeys,
  runIdempotent,
  withIdempotency,
} from './service';

export { canonicalize, requestFingerprint } from './fingerprint';
