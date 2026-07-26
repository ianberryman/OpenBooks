/**
 * The error code registry.
 *
 * ## Codes are part of the public contract
 *
 * Spec §8 makes the REST surface an integration contract, and an integrator that
 * has to distinguish "retry with a fresh idempotency key" from "the period is
 * closed, ask a human" cannot do it from an HTTP status — both are 4xx and 409
 * and 412 are far too coarse. So the code, not the status, is what integrator
 * code branches on, which makes every string below as load-bearing as a route
 * path.
 *
 * That has consequences for how this file may change:
 *
 * - A code is **never renamed**. Renaming `not_found` breaks every client that
 *   matched on it, silently, at runtime, with no compile step to catch it.
 * - A code's **status never changes** either. The table below is the single
 *   place status is derived from, precisely so that the pairing is a fact about
 *   the contract rather than something each throw site re-decides.
 * - Adding a code is additive and safe, but it happens *here*. A new error class
 *   that mints its own string would be a code outside the registry, invisible to
 *   the OpenAPI artifact (OB-022) and to anything documenting the surface.
 *
 * `snake_case` rather than `SCREAMING_CASE` or a numeric code: the value appears
 * in JSON bodies, and the rest of the wire surface is snake_case.
 */

/** The statuses this system is capable of returning for an error. */
export type HttpErrorStatus = 400 | 401 | 403 | 404 | 409 | 412 | 500;

export const ERROR_CODES = {
  VALIDATION_FAILED: 'validation_failed',
  UNAUTHENTICATED: 'unauthenticated',
  PERMISSION_DENIED: 'permission_denied',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  IDEMPOTENCY_KEY_CONFLICT: 'idempotency_key_conflict',
  PRECONDITION_FAILED: 'precondition_failed',
  INTERNAL_ERROR: 'internal_error',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Code → status, exhaustively. `Record<ErrorCode, …>` means a new code does not
 * compile until it has a status, so the HTTP layer (OB-022) can map any error it
 * is handed without a fallback branch that quietly becomes a 500.
 */
export const ERROR_CODE_STATUS: Readonly<Record<ErrorCode, HttpErrorStatus>> = {
  validation_failed: 400,
  unauthenticated: 401,
  permission_denied: 403,
  not_found: 404,
  // Two 409s on purpose. The status is identical and the recovery is not: a
  // plain conflict means the request was wrong, an idempotency-key conflict
  // means the *key* was reused with a different body and the client should
  // regenerate it (spec §12). Collapsing them would leave integrators guessing.
  conflict: 409,
  idempotency_key_conflict: 409,
  precondition_failed: 412,
  internal_error: 500,
};
