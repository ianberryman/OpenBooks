import type { ErrorDetails } from './base';
import { assertIdentifierToken, OpenBooksError } from './base';
import { ERROR_CODES } from './codes';

/** One field-level problem. A type alias, so it is assignable to `ErrorDetails`. */
export type ValidationIssue = {
  /** Dotted path into the request object, e.g. `lines.0.amount`. */
  readonly path: string;
  readonly message: string;
};

/**
 * The request was understood and is not a valid request. Schema violations
 * (OB-022 maps Zod issues here) and domain-shape violations alike — an unbalanced
 * journal is a validation failure, not a precondition failure, because nothing
 * about the system's state would make it acceptable.
 */
export class ValidationError extends OpenBooksError {
  constructor(message: string, issues: readonly ValidationIssue[] = []) {
    super(ERROR_CODES.VALIDATION_FAILED, message, issues.length === 0 ? undefined : { issues });
  }
}

/**
 * No usable identity on the request.
 *
 * Takes no message, on purpose. The two situations a caller wants to describe
 * here — "no such user" and "wrong password" — are exactly the pair that must
 * stay indistinguishable, or the login endpoint becomes a user-enumeration
 * oracle. Same reasoning as A7, applied one layer earlier.
 */
export class UnauthenticatedError extends OpenBooksError {
  constructor() {
    super(ERROR_CODES.UNAUTHENTICATED, 'Authentication required.');
  }
}

/**
 * The caller is authenticated and the role it holds in this org does not carry
 * the permission the operation declared (spec §5, enforced by OB-016).
 *
 * Takes a permission key and nothing else — see the A7 note on `NotFoundError`.
 * A 403 is a statement about the *caller*, never about an object; the moment it
 * can name an object it becomes an existence oracle.
 */
export class PermissionDeniedError extends OpenBooksError {
  constructor(permission: string) {
    assertIdentifierToken(permission, 'permission');
    super(ERROR_CODES.PERMISSION_DENIED, `Permission denied: ${permission}.`, { permission });
  }
}

/**
 * The requested object is not visible to this caller.
 *
 * ## A7: why this constructor accepts a resource *name* and nothing else
 *
 * Acceptance criterion A7 is that a cross-org read returns nothing and does not
 * leak existence. Concretely: asking for an object that belongs to another org
 * must be byte-for-byte indistinguishable from asking for one that was never
 * created. A `403` in the cross-org case would satisfy "returns nothing" and
 * still fail A7 outright — it confirms the id is real, which is all an attacker
 * enumerating ids needs.
 *
 * Three things make that the default rather than something each service
 * remembers:
 *
 * 1. **The row never arrives.** `tenantDb(ctx)` (OB-013) injects
 *    `where org_id = ctx.orgId` into every tenant query, so a cross-org lookup
 *    returns zero rows. Service code does not *learn* that the object exists
 *    elsewhere, so it has nothing to leak. A7 is enforced at the query builder
 *    first; this class is what makes the remaining path safe.
 *
 * 2. **The zero-row path has exactly one error.** `assertFound()` is the
 *    sanctioned way to turn "no row" into a thrown error, and it throws this.
 *    There is no second error class meaning "exists, but not yours", so the
 *    cross-org branch and the never-existed branch are not merely *mapped* to the
 *    same response — they are the same line of code.
 *
 * 3. **There is no channel for a distinguishing detail.** This constructor takes
 *    a validated resource token: no free-text message, no `details` bag, no id
 *    echo. `new NotFoundError('invoice')` is the only expressible form, so two
 *    calls for two different reasons produce identical output by construction
 *    rather than by matching phrasing. `assertIdentifierToken` is what closes the
 *    obvious hole — `new NotFoundError('invoice 42, owned by org B')` throws.
 *
 * Leaking therefore takes deliberate effort: reaching past `tenantDb`, or adding
 * a field to this class, or throwing `PermissionDeniedError` for an object
 * lookup. All three are visible in review; none is a thing you do by forgetting.
 */
export class NotFoundError extends OpenBooksError {
  constructor(resource: string) {
    assertIdentifierToken(resource, 'resource');
    super(ERROR_CODES.NOT_FOUND, `No such ${resource}.`, { resource });
  }
}

/**
 * The request collides with existing state in this org — a duplicate account
 * code, a period that already covers the range.
 *
 * Free text is allowed here, unlike `NotFoundError`, because reaching a conflict
 * means the colliding row is inside the caller's own org: the uniqueness
 * constraints it can violate are all `(org_id, …)` composites, so there is no
 * cross-org existence to disclose.
 */
export class ConflictError extends OpenBooksError {
  constructor(message: string, details?: ErrorDetails) {
    super(ERROR_CODES.CONFLICT, message, details);
  }
}

/**
 * An `Idempotency-Key` was replayed with a different request body (spec §12,
 * OB-017).
 *
 * Its own code rather than a `ConflictError` because the recovery differs and
 * only the code tells a client which one it is: a plain conflict means fix the
 * request, this means the key was reused and must be regenerated. Deriving from
 * `OpenBooksError` rather than `ConflictError` keeps the code a constructor fact
 * instead of an overridden field.
 */
export class IdempotencyKeyConflictError extends OpenBooksError {
  constructor() {
    super(
      ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
      'This Idempotency-Key was already used with a different request body. ' +
        'Generate a new key to submit a different request.',
    );
  }
}

/**
 * The request is well-formed and permitted, and the system's current state
 * forbids it — posting into a closed period being the M1 case (A4, OB-019).
 *
 * Distinct from `ValidationError` because the distinction is actionable: a
 * validation failure means change the request, a precondition failure means
 * change the state (or wait). `precondition` is a stable token so a client can
 * branch on *which* precondition without parsing prose.
 */
export class PreconditionFailedError extends OpenBooksError {
  constructor(precondition: string, message: string) {
    assertIdentifierToken(precondition, 'precondition');
    super(ERROR_CODES.PRECONDITION_FAILED, message, { precondition });
  }
}

/**
 * A bug or an unavailable dependency.
 *
 * `message` is for logs only — `clientMessage` is fixed, so a stack-shaped
 * message, a SQL fragment, or a connection string cannot reach a response by
 * being passed to the wrong constructor.
 */
export class InternalError extends OpenBooksError {
  constructor(message: string, details?: ErrorDetails) {
    super(ERROR_CODES.INTERNAL_ERROR, message, details);
  }

  override get clientMessage(): string {
    return 'An internal error occurred.';
  }
}
