/**
 * The only place this package reads its environment.
 *
 * The same rule OB-003 enforces on the server (spec §3: resolve config once, validate
 * it, fail fast with a message naming the variable) rather than a second convention
 * for the browser. `openbooks/no-process-env` cannot help here — Vite replaces
 * `import.meta.env` at build time and there is no `process` in a browser — so the
 * discipline is that this is the only file in `packages/web` that mentions it.
 *
 * Fail-fast means throwing during module evaluation, which renders a blank page. That
 * is the correct trade: `VITE_*` values are inlined at build time, so a malformed base
 * URL is a broken artifact rather than a runtime accident, and the alternative —
 * falling back to same-origin — would send every request of a cross-origin deployment
 * to the static-asset host, where they return `index.html` with a 200.
 */

/**
 * Empty, an absolute `http(s)` origin with an optional path prefix, or a root-relative
 * prefix. No query and no fragment: `openapi-fetch` concatenates `baseUrl + pathname`
 * and appends its own query string, so a `?` here would produce a URL with two.
 */
const API_BASE_URL_PATTERN = /^(?:https?:\/\/[^/?#]+)?(?:\/[^?#]*)?$/;

export class ApiBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiBaseUrlError';
  }
}

/**
 * Same-origin by default, and that default is the supported deployment rather than a
 * convenience.
 *
 * The session is an `HttpOnly` cookie with `SameSite=Lax` (`packages/server/src/modules/
 * auth/cookie.ts`) and the API ships no CORS layer, so a browser will not carry the
 * session to a different site at all and will not permit a credentialed cross-origin
 * request without `Access-Control-Allow-Credentials`. Same-origin sidesteps both:
 * `vite.config.ts` proxies `/v1` and `/health` in dev, and a reverse proxy or a second
 * CloudFront behaviour does the same in production.
 *
 * Set the variable only when the API genuinely lives elsewhere — the hosted layout in
 * `infra/terraform/modules/edge/` puts the bundle on CloudFront and the API on a
 * separate `api_fqdn`, which needs a same-site parent domain (`SESSION_COOKIE_DOMAIN`)
 * *and* server-side CORS that does not exist yet. See the note in `.env.example`.
 */
function resolveApiBaseUrl(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim();
  // Normalized here rather than relied on downstream: openapi-fetch strips a trailing
  // slash itself, so leaving one in would make the exported value differ from the one
  // actually used, which is the sort of gap a log line is then read against.
  const value = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;

  if (value === '') return '';

  if (!API_BASE_URL_PATTERN.test(value)) {
    throw new ApiBaseUrlError(
      `VITE_API_BASE_URL must be an http(s) origin (optionally with a path prefix) or a ` +
        `root-relative path, with no query or fragment. Received ${JSON.stringify(raw)}.`,
    );
  }

  return value;
}

/** Prefix for every request the generated client makes. `''` means same-origin. */
export const API_BASE_URL: string = resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL);
