import createOpenApiClient from 'openapi-fetch';
import type { Client, Middleware } from 'openapi-fetch';

import { API_BASE_URL } from '../env';
import { IDEMPOTENCY_KEY_HEADER } from './idempotency';
import type { paths } from './schema';

/**
 * The typed client, generated from `openapi.json` and configured against the real surface.
 *
 * Spec §12: the React app consumes the public REST API only, and this module is the whole
 * of its access to it. `paths` comes from `schema.d.ts`, which is generated from the
 * committed artifact and gated against drift by `scripts/check-client-drift.mjs`, so the
 * types here cannot describe a surface the server does not serve.
 */

/**
 * Methods that cannot change state, and therefore need no idempotency key.
 *
 * `OPTIONS` is included because a preflight is issued by the browser, not by this client
 * — it would never carry the header and asserting otherwise would fail on the first
 * cross-origin request.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A write reached the network with no `Idempotency-Key`.
 *
 * This is a programming error, not a server response, so it is thrown rather than
 * returned as an `ApiError`: there is no HTTP status to report and nothing for a screen's
 * retry affordance to do with it.
 */
export class MissingIdempotencyKeyError extends Error {
  constructor(method: string, schemaPath: string) {
    super(
      `${method} ${schemaPath} is a write and carries no ${IDEMPOTENCY_KEY_HEADER} header. ` +
        `Every write on this API requires one (spec §12); pass ` +
        `params.header: idempotencyHeader(key) with a key minted once per user intent, not ` +
        `once per attempt.`,
    );
    this.name = 'MissingIdempotencyKeyError';
  }
}

/**
 * The runtime backstop behind the type-level requirement.
 *
 * The generated types already make a write without the header uncompilable (see
 * `./idempotency`), so on the typed path this never fires. It exists for the paths the
 * types do not reach — `client.request(method, path, init)` with a widened method, a
 * `params` object built dynamically, a `headers: { 'idempotency-key': undefined }` that
 * un-sets it — and it fails loudly rather than minting a key, because a key invented here
 * would be a *different* key on every retry and would turn a retried write into a second
 * posting. A 400 from the server and an exception here are both correct outcomes; the
 * exception names the fix.
 */
const requireIdempotencyKey: Middleware = {
  onRequest({ request, schemaPath }) {
    if (SAFE_METHODS.has(request.method)) return undefined;

    const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
    // A blank key is rejected by the server's context hook before the route runs, so
    // treating it as absent here reports the same fault with the more useful message.
    if (key === null || key.trim() === '') {
      throw new MissingIdempotencyKeyError(request.method, schemaPath);
    }

    return undefined;
  },
};

export function createApiClient(baseUrl: string = API_BASE_URL): Client<paths> {
  const client = createOpenApiClient<paths>({
    baseUrl,
    /**
     * The session is an opaque token in an `HttpOnly` cookie (OB-015, spec §5), so it
     * cannot be read or attached by this code — the browser must send it.
     *
     * `'include'` rather than `'same-origin'` deliberately. Same-origin is what the dev
     * proxy and a reverse-proxied self-host deployment are, and `'same-origin'` would
     * cover both; it would then silently omit the cookie in the split-origin hosted
     * layout, producing a 401 on every request with nothing in the browser to indicate
     * why. `'include'` is correct in all three, and where it needs the server's
     * cooperation (CORS with `Access-Control-Allow-Credentials`) the failure is a
     * console-visible CORS error rather than a mystery logout.
     */
    credentials: 'include',
  });

  client.use(requireIdempotencyKey);

  return client;
}

/**
 * The application's client.
 *
 * A module singleton because the base URL is fixed at build time and the client holds no
 * per-user state — the session lives in a cookie the browser owns. `createApiClient` is
 * exported for tests and for anything that needs a second base URL.
 */
export const api: Client<paths> = createApiClient();
