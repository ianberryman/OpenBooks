import type { components } from './schema';

/**
 * Turning an `openapi-fetch` result into a value or a throw.
 *
 * `openapi-fetch` returns `{ data } | { error }` and never rejects on a non-2xx, which is
 * right for the transport and wrong for TanStack Query — a `queryFn` signals failure by
 * throwing. This is the one adapter between the two, so no caller has to remember which
 * convention it is in.
 */

/**
 * The body of every non-2xx response on this API.
 *
 * Not a guess: every route declares `default: errorResponseSchema` (see the note in
 * `packages/server/src/transport/routes/support.ts` on why `default` rather than an
 * enumerated status list), so the generated type covers every failure the *server*
 * produces.
 */
export type ApiErrorBody = components['schemas']['ErrorResponse'];

/**
 * Stable machine-readable failure code. Integrators — and screens — branch on this
 * rather than on the HTTP status, because `conflict` and `idempotency_key_conflict` are
 * both 409 with different recoveries.
 */
export type ApiErrorCode = ApiErrorBody['error']['code'];

/**
 * A failed API call.
 *
 * `code` is `null` when the response did not carry this API's error envelope, and that
 * case is real rather than defensive padding: a load balancer 502, a CloudFront error
 * page, or — the one that actually happens in development — the Vite dev server
 * answering a proxied path it has no proxy rule for, which returns `index.html` with a
 * 200. Those are responses the server never wrote, so parsing them as `ApiErrorBody`
 * would invent a `code` the ledger's error catalog does not contain.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | null;
  readonly body: unknown;

  constructor(status: number, code: ApiErrorCode | null, message: string, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }

  static from(response: Response, body: unknown): ApiError {
    if (isApiErrorBody(body)) {
      return new ApiError(response.status, body.error.code, body.error.message, body);
    }
    return new ApiError(
      response.status,
      null,
      `The API returned ${String(response.status)} with a body this client does not recognize. ` +
        `Either something between the client and the API answered, or the two are on ` +
        `different versions of openapi.json.`,
      body,
    );
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value;
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

/**
 * The body of a successful call, or a throw.
 *
 * Deliberately refuses a 2xx with no body instead of returning `undefined`: the 204
 * routes (`logout`, `deleteAccount`) have nothing to unwrap, and a helper that quietly
 * returned `undefined` for them would let a screen render an empty state that is
 * indistinguishable from a real one. M2 adds the sibling for those; until a screen calls
 * one, guessing at its signature is worth less than the loud message below.
 */
export function unwrap<T>(result: {
  readonly data?: T | undefined;
  readonly error?: unknown;
  readonly response: Response;
}): T {
  if (!result.response.ok || result.error !== undefined) {
    throw ApiError.from(result.response, result.error);
  }

  if (result.data === undefined) {
    throw new ApiError(
      result.response.status,
      null,
      `Expected a response body from ${result.response.url} and received none. A 204 route ` +
        `needs a different helper than unwrap().`,
      undefined,
    );
  }

  return result.data;
}
