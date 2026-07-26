/**
 * Recognising the MySQL errors the application treats as answers rather than faults.
 *
 * A driver error that reaches `toWireError` unrecognised becomes an opaque
 * `internal_error` — the server taking blame for a request it understood and
 * deliberately refused. Every entry here exists because a unique key or a grant is
 * the *real* guarantee for some rule, while the application's own pre-check races
 * with it. The pre-check produces the good message; this turns the losing race into
 * the same answer instead of a 500.
 *
 * Hoisted after three modules wrote the errno check independently. Kept in `src/db`
 * because these are properties of the driver, not of any one domain.
 */

/** ER_DUP_ENTRY — a unique index rejected the row. */
const DUPLICATE_ENTRY = 1062;

/** ER_TABLEACCESS_DENIED_ERROR — the grant for this verb on this table is absent. */
const TABLE_ACCESS_DENIED = 1142;

/** ER_NO_REFERENCED_ROW_2 — an FK's parent row does not exist. */
const NO_REFERENCED_ROW = 1452;

/** ER_ROW_IS_REFERENCED_2 — a child row still references this parent. */
const ROW_IS_REFERENCED = 1451;

/** ER_LOCK_DEADLOCK — the transaction was chosen as a deadlock victim. */
const LOCK_DEADLOCK = 1213;

/** ER_LOCK_WAIT_TIMEOUT — a lock wait exceeded innodb_lock_wait_timeout. */
const LOCK_WAIT_TIMEOUT = 1205;

function errnoOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('errno' in error)) return undefined;
  const { errno } = error as { readonly errno?: unknown };
  return typeof errno === 'number' ? errno : undefined;
}

export function isDuplicateEntryError(error: unknown): boolean {
  return errnoOf(error) === DUPLICATE_ENTRY;
}

export function isAccessDeniedError(error: unknown): boolean {
  return errnoOf(error) === TABLE_ACCESS_DENIED;
}

export function isMissingParentError(error: unknown): boolean {
  return errnoOf(error) === NO_REFERENCED_ROW;
}

export function isStillReferencedError(error: unknown): boolean {
  return errnoOf(error) === ROW_IS_REFERENCED;
}

/**
 * Deadlock or lock-wait timeout — the two outcomes a caller may legitimately retry.
 *
 * Distinguished from the others because they say nothing about the request: the same
 * request, retried, may succeed. Posting serializes per org on the sequence counter
 * (D-14), so under contention these are the expected losing outcome rather than a
 * sign of a mistake.
 */
export function isRetryableConcurrencyError(error: unknown): boolean {
  const errno = errnoOf(error);
  return errno === LOCK_DEADLOCK || errno === LOCK_WAIT_TIMEOUT;
}
