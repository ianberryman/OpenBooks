import { ApiError } from '../api';
import { API_BASE_URL } from '../env';

/**
 * A minimal fetch-based JSON client for endpoints not yet in the generated client
 * (OB-131, Phase 1, S4 — invoice delivery + branding).
 *
 * `src/api/client.ts` is generated from `openapi.json` (`schema.d.ts`), and `/v1/branding`,
 * `POST /v1/branding/logo`, `POST /v1/invoices/{id}/send` and the public hosted-invoice read
 * land in the F2/S5 streams in parallel — they are not in `schema.d.ts` yet, so `api.GET`/
 * `api.POST` cannot name them and will not compile against them. This module reproduces just
 * enough of `src/api/client.ts`'s behaviour — the base URL, credentials, JSON parsing, and
 * throwing `ApiError` on a non-2xx — that the three screens built against it need no
 * rewrite once the routes are generated, only a narrower one: each call site swaps
 * `thinRequest('/v1/branding', { method: 'GET' })` for `unwrap(await api.GET('/v1/branding'))`
 * and the hand-written request/response interfaces in `branding-client.ts` and
 * `delivery-client.ts` are deleted in favour of `components['schemas'][...]`.
 *
 * What is deliberately not reproduced: the idempotency **type-level** enforcement
 * `src/api/client.ts` gets from `openapi-fetch`'s generated `parameters` (`src/api/
 * idempotency.ts`). A write through this module that forgets its key is a bug this module
 * cannot catch at compile time the way the generated client does — every call site here
 * passes one regardless.
 *
 * Types are hand-mirrored from `@openbooks/shared-types` rather than imported from it, for
 * the reason `src/money/format.ts`'s header gives for not importing `toDecimalString`:
 * `@openbooks/web` is not a dependency of that package, and reaching it anyway would
 * typecheck and then fail at `vite build`, which resolves nothing of the sort.
 */

export interface ThinRequestInit {
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** JSON body. The logo upload is JSON with a base64 `content` field, not multipart —
   *  see `branding-client.ts`'s `uploadBrandingLogo` — so every write through this module
   *  is JSON, with no second body shape to carry. */
  readonly body?: unknown;
  /** Required on every write; the server refuses one with no key (spec §12). */
  readonly idempotencyKey?: string;
  /** `'include'` (the default) for the authenticated surface, `'omit'` for the public one. */
  readonly credentials?: RequestCredentials;
}

async function parseJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // Not this API's error envelope either — `ApiError.from` below treats an unparsed
    // body the same way it treats a proxy's HTML error page (see its own doc comment).
    return undefined;
  }
}

/**
 * Fetches and parses a JSON response, throwing `ApiError` on anything that is not a
 * successful 2xx — the same contract `unwrap` gives the generated client's callers, so
 * `presentApiError` needs no case for "came through the thin client instead".
 */
export async function thinRequest<T>(path: string, init: ThinRequestInit): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.idempotencyKey !== undefined) headers['idempotency-key'] = init.idempotencyKey;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: init.method,
    credentials: init.credentials ?? 'include',
    headers,
    // Spread rather than `body: undefined`, because `exactOptionalPropertyTypes`
    // distinguishes an absent key from one holding `undefined`, and `RequestInit.body`
    // does not admit `undefined`.
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

  const parsed = await parseJsonBody(response);

  if (!response.ok) throw ApiError.from(response, parsed);

  if (parsed === undefined) {
    throw new ApiError(
      response.status,
      null,
      `Expected a response body from ${path} and received none.`,
      undefined,
    );
  }

  return parsed as T;
}
