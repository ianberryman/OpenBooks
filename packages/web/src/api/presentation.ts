import { ApiError } from './errors';
import type { ApiErrorCode } from './errors';

/**
 * The one mapping from the API's error codes to what a screen shows (OB-046).
 *
 * ## Why a table and not a `catch` per screen
 *
 * `packages/server/src/errors/codes.ts` makes the code — not the status — the thing
 * clients branch on, precisely because `conflict` and `idempotency_key_conflict` are both
 * 409 with different recoveries. That contract is worth nothing if each screen
 * rediscovers it: six screens branching on six subsets produce six different answers to
 * "the session expired", and the one that forgot `unauthenticated` shows a red box on a
 * page the user can no longer act on at all.
 *
 * So the mapping is exhaustive over `ApiErrorCode`, which is generated from
 * `openapi.json`. A code added on the server does not compile here until it is given a
 * presentation — that is the point of the `Record` below rather than a `switch` with a
 * default.
 *
 * ## What a screen does with the result
 *
 * `recovery` is the actionable half, and it is deliberately a small closed set rather than
 * a rendered button: what "sign in again" *means* is the router's business, not this
 * module's. `message` is a fallback, not a replacement — the server's own message is more
 * specific for the codes that carry one (a conflict names the colliding thing) and is used
 * in preference to it.
 */
export type ErrorRecovery =
  /** The request is wrong. The user must change something on this screen. */
  | 'fix-input'
  /** The session is gone. Send the user to sign in. */
  | 'sign-in'
  /** The caller lacks the permission, or the object is not theirs (A7 makes these one). */
  | 'no-access'
  /** State changed underneath. Refetch and let the user look again. */
  | 'refresh'
  /** Nothing the user can do here. Retrying may work; reporting it is reasonable. */
  | 'retry';

export interface PresentedError {
  readonly code: ApiErrorCode | null;
  readonly title: string;
  readonly message: string;
  readonly recovery: ErrorRecovery;
  /**
   * Field-level messages, keyed by the dotted path the server's `ValidationIssue` uses —
   * `'lines.0.amount'`. Empty unless the code is `validation_failed`.
   */
  readonly fieldErrors: Readonly<Record<string, string>>;
}

interface Presentation {
  readonly title: string;
  readonly message: string;
  readonly recovery: ErrorRecovery;
}

const PRESENTATION: Readonly<Record<ApiErrorCode, Presentation>> = {
  validation_failed: {
    title: 'Check the highlighted fields',
    message: 'Some of what was entered cannot be saved as it is.',
    recovery: 'fix-input',
  },
  unauthenticated: {
    title: 'Signed out',
    message: 'The session has ended. Sign in again to continue.',
    recovery: 'sign-in',
  },
  /**
   * Phrased as "not available to you", never "you do not have permission to view invoice
   * 42". A 403 in this system is a statement about the caller and never about an object
   * (the A7 note in `packages/server/src/errors/errors.ts`), and a message naming the
   * object would put back at the presentation layer the existence oracle the error classes
   * were built to withhold.
   */
  permission_denied: {
    title: 'Not available to you',
    message: 'Your role in this organization does not include this action.',
    recovery: 'no-access',
  },
  /**
   * The same presentation as `permission_denied`, and that is the design rather than
   * laziness: A7 requires a cross-org read to be indistinguishable from a miss. The server
   * returns 404 for both, and a UI that rendered "not found" differently from "not yours"
   * would re-open the distinction the server closed.
   */
  not_found: {
    title: 'Not found',
    message: 'This no longer exists, or it is not part of this organization.',
    recovery: 'no-access',
  },
  conflict: {
    title: 'That clashes with something already here',
    message: 'Something else in this organization already occupies this value.',
    recovery: 'refresh',
  },
  /**
   * The one code whose recovery is a *programming* action, not a user action: the key was
   * replayed with a different body, so the fix is to mint a new one (see
   * `src/api/idempotency.ts`). A user reading this has been shown a form whose key
   * outlived its content, which is a bug in the screen — hence `refresh` rather than an
   * instruction the user cannot follow.
   */
  idempotency_key_conflict: {
    title: 'This form was submitted twice with different contents',
    message: 'Reload the page and enter it once more.',
    recovery: 'refresh',
  },
  /**
   * Posting into a closed period is the M2 case that reaches this, and it is the one where
   * a generic "something went wrong" is actively harmful — the user must know that the
   * state, not their entry, is the problem. The server's own message names the
   * precondition, and `presentApiError` prefers it.
   */
  precondition_failed: {
    title: 'Not possible right now',
    message: 'The current state of the books does not allow this.',
    recovery: 'refresh',
  },
  internal_error: {
    title: 'Something went wrong',
    message: 'The request could not be completed. Nothing was saved.',
    recovery: 'retry',
  },
};

/**
 * A response that carried no error envelope — a proxy, a CDN error page, the Vite dev
 * server answering an unproxied path with `index.html` and a 200 (see `ApiError`).
 *
 * `retry` rather than `sign-in`, even for a 401 with an unrecognized body, because a
 * response this client cannot parse is not evidence about the session; treating it as one
 * would log the user out on a misconfigured reverse proxy.
 */
const UNRECOGNIZED: Presentation = {
  title: 'The server could not be reached',
  message: 'Something between this page and the API answered instead. Try again shortly.',
  recovery: 'retry',
};

const OFFLINE: Presentation = {
  title: 'No connection to the server',
  message: 'The request never arrived. Check the connection and try again.',
  recovery: 'retry',
};

interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

function isValidationIssue(value: unknown): value is ValidationIssue {
  return (
    typeof value === 'object' &&
    value !== null &&
    'path' in value &&
    typeof value.path === 'string' &&
    'message' in value &&
    typeof value.message === 'string'
  );
}

/**
 * Pulls `details.issues` out of a validation failure.
 *
 * Narrowed rather than cast. `details` is `{ [key: string]: unknown }` in the generated
 * types — OpenAPI cannot say more about a free-form bag — so a screen that trusted its
 * shape would be trusting a description, not a check. Anything that does not match is
 * dropped and the field simply has no message, which degrades to the form-level message
 * above it.
 */
function fieldErrorsFrom(error: ApiError): Readonly<Record<string, string>> {
  if (error.code !== 'validation_failed') return {};

  const body: unknown = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return {};
  const envelope: unknown = body.error;
  if (typeof envelope !== 'object' || envelope === null || !('details' in envelope)) return {};
  const details: unknown = envelope.details;
  if (typeof details !== 'object' || details === null || !('issues' in details)) return {};
  const issues: unknown = details.issues;
  if (!Array.isArray(issues)) return {};

  const fieldErrors: Record<string, string> = {};
  for (const issue of issues) {
    // First message per path wins: the server reports issues in schema order, and the
    // first is the one closest to what the user typed.
    if (isValidationIssue(issue) && !(issue.path in fieldErrors)) {
      fieldErrors[issue.path] = issue.message;
    }
  }
  return fieldErrors;
}

/**
 * Anything a `queryFn` or `mutationFn` threw, as something a screen can render.
 *
 * Takes `unknown` because that is what React Query's `error` is on the paths that matter —
 * a `fetch` rejection is a `TypeError`, not an `ApiError` — and a helper that demanded the
 * narrower type would leave every call site with the branch this one exists to own.
 */
export function presentApiError(error: unknown): PresentedError {
  if (!(error instanceof ApiError)) {
    return { code: null, ...OFFLINE, fieldErrors: {} };
  }

  if (error.code === null) {
    return { code: null, ...UNRECOGNIZED, fieldErrors: {} };
  }

  const presentation = PRESENTATION[error.code];

  return {
    code: error.code,
    title: presentation.title,
    /**
     * The server's message when it has one. Every code above has a usable fallback, but
     * the server's is more specific for exactly the codes where specificity is the whole
     * value — a conflict names what collided, a precondition names which one failed — and
     * `clientMessage`/`wireDetails` on the server already guarantee that an
     * `internal_error` carries a fixed, safe string rather than an operator's.
     */
    message: error.message === '' ? presentation.message : error.message,
    recovery: presentation.recovery,
    fieldErrors: fieldErrorsFrom(error),
  };
}
