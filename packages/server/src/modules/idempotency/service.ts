import type { Kysely } from 'kysely';

import { getContext } from '../../context';
import type { DB, TenantDatabase } from '../../db';
import { systemDb, tenantDb } from '../../db';
import type { JsonValue } from '../../errors';
import { IdempotencyKeyConflictError, InternalError, ValidationError } from '../../errors';
import type { ClaimStore, NewClaim } from './claims';
import { globalClaims, orgClaims } from './claims';
import { globalRequestFingerprint, requestFingerprint } from './fingerprint';
import { newIdBuffer, uuidToBuffer } from './ids';
import { normalizeResponseBody, readStoredResponseBody, serializeResponseBody } from './response';

/**
 * Idempotent execution (spec §12; migration `0003_idempotency`; ROADMAP D-04).
 *
 * The claim row is inserted inside the *same transaction* as the write it guards,
 * which is the entire design and the source of both guarantees:
 *
 *  - **Exactly one execution under a race.** Two concurrent requests carrying the
 *    same key both attempt `INSERT`. `uq_idempotency_org_key` serializes them: the
 *    second `INSERT` blocks on the first transaction's index lock and then, once
 *    that transaction commits, fails with `ER_DUP_ENTRY`. The loser rolls back
 *    without having run the operation and reads the committed outcome instead. The
 *    guarantee is MySQL's unique index, not application logic — spec §11's
 *    "duplicate idempotency key yields one journal" does not depend on any
 *    check-then-act window, because there is none.
 *
 *  - **A failure is not poison.** If the operation throws, the claim rolls back with
 *    it. There is no row, so a genuine retry re-claims the key and runs. The
 *    alternative — committing the claim before the work — would make any transient
 *    failure permanent from the client's point of view: it holds a key that can
 *    never succeed and never returns a response.
 *
 * A committed claim therefore always carries its response, because the claim and
 * the response commit together in one transaction. `settleExistingClaim` treats a
 * committed-but-incomplete row as a fault rather than as a state to wait on, and
 * that is why there is nothing to poll and no lease to expire.
 *
 * ## Two namespaces (OB-028)
 *
 * Everything above holds for an org-less claim too, because the serialization is
 * `uq_idempotency_scope_key` and `claim_scope` is the sentinel for those rows rather
 * than a NULL. What differs is only *how the row is addressed*, which is `claims.ts`
 * and nowhere else, and *what makes two requests the same*, which for a shared
 * namespace has to include the caller — see `globalRequestFingerprint`.
 *
 * The five endpoints that need it are register, login, logout, create-org, and
 * switch-org: the first two predate any org, the third may run with a session whose
 * org is already gone, and the last two would otherwise record the claim against the
 * org being created or the org being left. Until OB-028 they accepted an
 * `Idempotency-Key` and ignored it, which is worse than not accepting one.
 *
 * Nothing here locks a journal row, and nothing can: the app user holds no
 * `UPDATE`/`DELETE` on `journals`, and MySQL requires one of those alongside
 * `SELECT` for a locking read, so `SELECT ... FOR UPDATE` on a journal fails with
 * errno 1142 (pinned by `test/db/harness.test.ts`). The only rows locked are this
 * table's own, which is in `0004_app_grants`'s mutable allowlist.
 */

/**
 * How long a completed key is remembered: **7 days**.
 *
 * The window is the horizon over which a retry is recognised as a retry. Past it
 * the system has forgotten the request, so the same key executes again — see
 * `settleExistingClaim` — which means the window has to exceed the retry horizon of
 * every client, not the typical one.
 *
 * 24 hours is the industry-conventional choice and it is too short here. Spec §12's
 * named failure is a retried *payment record* double-posting, and the callers that
 * retry on a human timescale are exactly the ones that write money: a bank-feed
 * import that failed on Friday evening (M4), an MCP agent whose tool call errored
 * and gets re-run when someone reads the thread (M5), a queued job with exponential
 * backoff and a dead-letter replay. A weekend plus slack covers all three; a day
 * covers none of them.
 *
 * The cost is bounded and boring: one narrow row per write, for 7 days, reclaimed by
 * `purgeExpiredIdempotencyKeys`. Not configurable, deliberately — a per-deployment
 * knob on a correctness window invites someone to shorten it for disk and discover
 * what it was for later.
 */
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** `idempotency_keys.idempotency_key` is `VARCHAR(255)`. */
const MAX_KEY_LENGTH = 255;

const DEFAULT_SUCCESS_STATUS = 200;

const DEFAULT_PURGE_BATCH_SIZE = 1_000;

/** mysql2's `errno` for a unique constraint violation (`ER_DUP_ENTRY`). */
const DUPLICATE_ENTRY_ERRNO = 1062;

/**
 * Bounded because the loop is not a spin: an attempt only repeats when the winner
 * of the race *rolled back*, which leaves the key free and means the next attempt
 * executes rather than retrying. Three is generous for a sequence of genuine
 * failures; exhausting it means something is failing repeatedly and the caller
 * should hear about that rather than have it retried indefinitely.
 */
const MAX_CLAIM_ATTEMPTS = 3;

export interface IdempotencySpec {
  /**
   * Stable identity of the operation, `RouteDefinition.operationId` in practice.
   * Part of the fingerprint as well as its own column — see `fingerprint.ts`.
   */
  readonly endpoint: string;
  /** The validated request payload. Fingerprinted, never stored. */
  readonly request: unknown;
  /** Recorded on success. Defaults to 200. */
  readonly successStatus?: number;
}

/**
 * The guarded write.
 *
 * It receives the *transactional*, org-scoped handle, and it must use it: a
 * callback that ignores the parameter and reaches for `tenantDb(...)` itself opens a
 * second transaction, and then the claim and the write no longer commit together —
 * which is the only property this module has. The type cannot express "you must use
 * this", so it is stated here and in `index.ts`.
 */
export type IdempotentOperation = (db: TenantDatabase) => Promise<unknown>;

/**
 * The guarded write for an org-less claim.
 *
 * It takes nothing, and that is the whole difference: there is no org, so there is
 * no scoped handle to hand over and no seam for a caller to get wrong. The write
 * joins the claim's transaction ambiently — `systemDb()` inside `register` or
 * `createOrg` returns it (`src/db/transaction-scope.ts`), which is what makes the
 * claim and the write commit together.
 */
export type GlobalIdempotentOperation = () => Promise<unknown>;

export type IdempotentOutcome = 'executed' | 'replayed';

export interface IdempotentResult {
  readonly outcome: IdempotentOutcome;
  readonly status: number;
  /**
   * The stored response, deep-equal on first execution and on every replay. See
   * `response.ts` for why the first response is the normalized value rather than
   * the operation's own return.
   */
  readonly body: JsonValue;
}

export interface IdempotencyOptions {
  /** Defaults to `IDEMPOTENCY_RETENTION_MS`. Overridden by tests, not by config. */
  readonly retentionMs?: number;
  /** Injectable clock, so expiry is testable without waiting out a retention window. */
  readonly clock?: () => Date;
}

export interface PurgeOptions {
  readonly clock?: () => Date;
  readonly batchSize?: number;
}

/**
 * Internal control flow: the claim is held by another transaction. Never escapes
 * this module — it is caught by the retry loop, which either replays or re-claims.
 *
 * A private `Error` subclass rather than a sentinel value because it is thrown
 * through Kysely's transaction body to trigger the rollback, and `only-throw-error`
 * (correctly) refuses anything else.
 */
class ClaimTaken extends Error {
  constructor() {
    super('The idempotency key is claimed by another transaction.');
    this.name = 'ClaimTaken';
  }
}

/**
 * The transport-facing entry point (OB-022 registers it, OB-023's write routes use
 * it). Everything ambient is resolved here and nowhere else: the org and the key
 * come from request context, per spec §4's rule that `orgId` never travels as a
 * parameter.
 *
 * ```ts
 * const result = await withIdempotency(
 *   { endpoint: route.operationId, request: input, successStatus: 201 },
 *   (trx) => postJournalIn(trx, input, ctx),
 * );
 * reply.status(result.status).send(result.body);
 * ```
 */
export async function withIdempotency(
  spec: IdempotencySpec,
  operation: IdempotentOperation,
  options?: IdempotencyOptions,
): Promise<IdempotentResult> {
  // `async` even though nothing is awaited before the first branch: a function that
  // sometimes throws synchronously and sometimes rejects makes every caller's error
  // handling conditional on which failure it hit. `getContext` still reads inside the
  // AsyncLocalStorage scope, because an async body runs synchronously up to its first
  // `await`.
  const context = getContext('withIdempotency()');
  const key = requireIdempotencyKey(context.idempotencyKey);

  return await runIdempotent(tenantDb(uuidToBuffer(context.orgId)), key, spec, operation, options);
}

/**
 * The org-less entry point (OB-028): the same guarantee for a write that has no org
 * to claim against.
 *
 * A separate function rather than a flag on `IdempotencySpec`, because the choice of
 * namespace is a property of the operation and is settled at the call site once. A
 * flag would default one way, and the direction it defaults is the direction it gets
 * forgotten in — an org write that quietly claimed globally would share a namespace
 * with every tenant.
 *
 * The principal is the caller's `userId`, read here for the same reason the org is:
 * spec §4 keeps scope out of parameters. It is null for register and login, which
 * run before there is a caller to name.
 */
export async function withGlobalIdempotency(
  spec: IdempotencySpec,
  operation: GlobalIdempotentOperation,
  options?: IdempotencyOptions,
): Promise<IdempotentResult> {
  const context = getContext('withGlobalIdempotency()');
  const key = requireIdempotencyKey(context.idempotencyKey);

  return await runGlobalIdempotent(systemDb(), context.userId, key, spec, operation, options);
}

/**
 * The core for an org claim, with every dependency explicit.
 *
 * Split from `withIdempotency` the way `createLogger` is split from `getLogger`: the
 * ambient resolution is one small function and the behaviour under test takes its
 * database and its key as arguments. That is what lets the concurrency tests drive
 * two genuinely separate connections through the real code path instead of
 * simulating a race against one pool.
 */
export async function runIdempotent(
  db: TenantDatabase,
  key: string,
  spec: IdempotencySpec,
  operation: IdempotentOperation,
  options?: IdempotencyOptions,
): Promise<IdempotentResult> {
  return runClaimed(
    orgClaims(db),
    key,
    requestFingerprint(spec.endpoint, spec.request),
    spec,
    operation,
    options,
  );
}

/** The same core for a global claim. Split from `withGlobalIdempotency` for the same reason. */
export async function runGlobalIdempotent(
  db: Kysely<DB>,
  principal: string | null,
  key: string,
  spec: IdempotencySpec,
  operation: GlobalIdempotentOperation,
  options?: IdempotencyOptions,
): Promise<IdempotentResult> {
  return runClaimed(
    globalClaims(db),
    key,
    globalRequestFingerprint(principal, spec.endpoint, spec.request),
    spec,
    operation,
    options,
  );
}

/**
 * The claim protocol, stated once for both namespaces.
 *
 * The fingerprint arrives already computed, because it is the one thing the two
 * namespaces genuinely disagree about; everything below — the fast path, the
 * transaction, the insert race, the retry bound — is identical, and it has to stay
 * identical or A8 holds for one namespace and not the other.
 */
async function runClaimed<H>(
  store: ClaimStore<H>,
  key: string,
  fingerprint: string,
  spec: IdempotencySpec,
  operation: (handle: H) => Promise<unknown>,
  options?: IdempotencyOptions,
): Promise<IdempotentResult> {
  const clock = options?.clock ?? defaultClock;
  const retentionMs = options?.retentionMs ?? IDEMPOTENCY_RETENTION_MS;
  const status = spec.successStatus ?? DEFAULT_SUCCESS_STATUS;

  assertUsableKey(key);
  assertUsableStatus(status);

  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt += 1) {
    // Fast path. A retry that arrives after the original completed is the common
    // case by a wide margin, and answering it costs one indexed read instead of a
    // transaction opened only to be rolled back by the duplicate insert. Racing this
    // read is harmless: it can only miss a row, and the `INSERT` below is the
    // authority on whether the key is free.
    const replay = await settleExistingClaim(store, key, fingerprint, clock());
    if (replay !== undefined) return replay;

    try {
      return await store.transaction(async (trx) => {
        const claimId = newIdBuffer();
        const claimedAt = clock();

        await insertClaim(trx, {
          id: claimId,
          key,
          endpoint: spec.endpoint,
          fingerprint,
          expiresAt: new Date(claimedAt.getTime() + retentionMs),
        });

        const body = normalizeResponseBody(await operation(trx.handle));
        await completeClaim(trx, claimId, status, body, clock());

        return { outcome: 'executed', status, body };
      });
    } catch (error) {
      // Anything else — including the operation's own failure — propagates with the
      // claim already rolled back, so the client's retry re-claims and runs.
      if (!(error instanceof ClaimTaken)) throw error;
    }
  }

  throw new InternalError(
    `Could not claim idempotency key after ${MAX_CLAIM_ATTEMPTS} attempts. Each attempt lost ` +
      'the insert race and then found no committed claim, which means the winner rolled back ' +
      'every time — the guarded operation is failing, not the claim.',
  );
}

/**
 * `RouteDefinition.requiresIdempotencyKey` declares the requirement and this
 * enforces it, exactly as plugin-api's `OperationContext` comment says. A 400 rather
 * than a silent unguarded write: spec §12 requires the key on every write endpoint,
 * so a request without one has not asked for what the endpoint offers.
 */
function requireIdempotencyKey(key: string | null): string {
  if (key === null) {
    throw new ValidationError('This operation requires an Idempotency-Key.', [
      {
        path: 'Idempotency-Key',
        message:
          'Required on every write. Send one unique value per logical request and reuse it ' +
          'verbatim when retrying.',
      },
    ]);
  }
  return key;
}

/**
 * Reclaims storage for keys past their retention window (`idx_idempotency_expires`).
 *
 * Org-scoped, and called per org from inside the M5 worker's `runInDerivedContext`
 * loop rather than as one cross-org sweep. A global `DELETE ... WHERE expires_at < ?`
 * would be marginally cheaper and would be the only statement in the application
 * touching a tenant table without org scope — spec §4's guarantee is worth more than
 * one saved index scan, and per-org batches also keep the lock footprint small
 * enough that a sweep never delays a live write.
 *
 * Expiry itself is *not* enforced by this function. `settleExistingClaim` treats an
 * expired row as absent whether or not cleanup has run, so behaviour does not depend
 * on when the worker last executed. Scheduling is M5's; this is the whole of the
 * cleanup path.
 */
export async function purgeExpiredIdempotencyKeys(
  db: TenantDatabase,
  options?: PurgeOptions,
): Promise<number> {
  return purgeStore(orgClaims(db), options);
}

/**
 * The same, for the org-less namespace (OB-028).
 *
 * A second function rather than a parameter, because it is called a different number
 * of times: the org sweep runs once per org inside the worker's `runInDerivedContext`
 * loop, and this runs **once** per sweep — there is no org to derive a scope from, and
 * calling it per org would delete the same rows N times over.
 */
export async function purgeExpiredGlobalIdempotencyKeys(
  db: Kysely<DB>,
  options?: PurgeOptions,
): Promise<number> {
  return purgeStore(globalClaims(db), options);
}

async function purgeStore<H>(store: ClaimStore<H>, options?: PurgeOptions): Promise<number> {
  const now = (options?.clock ?? defaultClock)();
  const batchSize = options?.batchSize ?? DEFAULT_PURGE_BATCH_SIZE;
  let purged = 0;

  for (;;) {
    const deleted = await store.purgeExpired(now, batchSize);
    purged += deleted;
    if (deleted < batchSize) return purged;
  }
}

function defaultClock(): Date {
  return new Date();
}

/**
 * Resolves an existing claim to a replay, a conflict, or "the key is free".
 *
 * Read without `FOR UPDATE`, and it does not need one. The only transition a
 * committed claim row ever undergoes is deletion at expiry: claim and completion are
 * one transaction, so a row that is visible is a row that is finished. There is no
 * check-then-act to protect, because the acting is done by the unique index in
 * `insertClaim`.
 */
async function settleExistingClaim<H>(
  store: ClaimStore<H>,
  key: string,
  fingerprint: string,
  now: Date,
): Promise<IdempotentResult | undefined> {
  const row = await store.find(key);

  if (row === undefined) return undefined;

  // Expiry checked before the fingerprint, on purpose. Past the window the system
  // has forgotten the request, so reusing the key with a *different* body is
  // legitimate reuse rather than a conflict — a 409 there would be telling the
  // client about a request nobody is entitled to remember.
  //
  // The honest consequence: an expired key that is reused with the *same* body
  // executes a second time and can double-post. That is not a bug to be patched at
  // this line, it is what a finite retention window means, and it is why
  // `IDEMPOTENCY_RETENTION_MS` is chosen against client retry horizons rather than
  // against disk.
  if (row.expires_at.getTime() <= now.getTime()) {
    await store.discard(row.id);
    return undefined;
  }

  // Note the collation: `utf8mb4_0900_ai_ci` makes the unique index case- and
  // accent-insensitive, so keys differing only in case are the same key. That fails
  // closed — the second request replays, or 409s if its body differs — so it is
  // pinned by a test rather than worked around with a case-sensitive comparison the
  // index could not use.
  if (row.request_fingerprint !== fingerprint) throw new IdempotencyKeyConflictError();

  if (row.completed_at === null || row.response_status === null) {
    throw new InternalError(
      'Found a committed idempotency claim with no response. The claim and the response ' +
        'commit in one transaction, so this state is unreachable through withIdempotency() — ' +
        'something else is writing idempotency_keys.',
    );
  }

  return {
    outcome: 'replayed',
    status: row.response_status,
    body: readStoredResponseBody(row.response_body),
  };
}

async function insertClaim<H>(store: ClaimStore<H>, row: NewClaim): Promise<void> {
  try {
    await store.insert(row);
  } catch (error) {
    // Under contention this statement *blocked* until the holder committed, which is
    // where the serialization happens. Two other outcomes are possible and both are
    // correctly left to propagate: a lock-wait timeout (1205) or a deadlock (1213)
    // rolls the claim back, so the client's retry with the same key is safe.
    if (!isDuplicateEntry(error)) throw error;
    throw new ClaimTaken();
  }
}

async function completeClaim<H>(
  store: ClaimStore<H>,
  id: Buffer,
  status: number,
  body: JsonValue,
  completedAt: Date,
): Promise<void> {
  const updated = await store.complete(id, status, serializeResponseBody(body), completedAt);

  // Zero rows would commit a claim with no response — the one state
  // `settleExistingClaim` declares unreachable, and `chk_idempotency_completion`
  // permits it (both columns NULL is a valid *unclaimed* row). Cheap to assert, and
  // it fails the write rather than leaving a key that replays nothing.
  if (updated === 0) {
    throw new InternalError('The idempotency claim inserted by this transaction disappeared.');
  }
}

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errno' in error &&
    (error as { readonly errno?: unknown }).errno === DUPLICATE_ENTRY_ERRNO
  );
}

/**
 * A `ValidationError`, so a client that sends an unusable key learns that rather
 * than receiving MySQL's truncation error as a 500. The key is otherwise opaque —
 * no format is imposed, because a caller's existing correlation id is the most
 * likely thing to be reused as one.
 */
function assertUsableKey(key: string): void {
  if (key.trim().length === 0) {
    throw new ValidationError('Idempotency-Key must not be blank.', [
      { path: 'Idempotency-Key', message: 'Must contain at least one non-whitespace character.' },
    ]);
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`, [
      { path: 'Idempotency-Key', message: `Received ${key.length} characters.` },
    ]);
  }
}

/** Declared by the route, not sent by the client, so a bad one is an internal fault. */
function assertUsableStatus(status: number): void {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new InternalError(`successStatus must be an HTTP status code, received ${status}.`);
  }
}
