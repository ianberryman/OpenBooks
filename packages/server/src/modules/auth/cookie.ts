/**
 * The session cookie: its name, its lifetime, and the attributes it is set with
 * (spec §5).
 *
 * `@fastify/cookie` is registered by `src/transport/app.ts`, which also sets these
 * attributes as the plugin's `parseOptions` defaults. They are restated here rather
 * than inherited, because a default is silent when it is wrong: dropping `httpOnly`
 * from the plugin's options would make every session cookie readable by script and
 * nothing in this module would change. Stating them at the point the session cookie is
 * built means the descriptor a route sends is the descriptor this file wrote.
 *
 * Nothing here touches a `reply`. These functions return a value; the route (OB-023)
 * hands it to `reply.setCookie`. That is what keeps the module callable from the MCP
 * surface (M5) and the workflow engine (M6), neither of which has an HTTP reply.
 *
 * ## Not signed, deliberately
 *
 * `@fastify/cookie` is configured with `config.session.secret`, so signing is
 * available and is not used for this cookie. A signature over the token would add no
 * unguessability — the token is already 256 bits of CSPRNG output (`tokens.ts`) — and
 * it would make `SESSION_SECRET` a second authority on whether a session is live,
 * so rotating the secret would log every user out while `sessions` said otherwise.
 * ROADMAP D-03 chose server-side sessions precisely so revocation is a database fact.
 *
 * The property signing is usually reached for — telling a forged credential apart from
 * an absent one — is delivered without it: a cookie that names no live session is
 * "credentials present and rejected", which `identity.ts` answers with
 * `UnauthenticatedError`, while no cookie at all resolves to `null`. The transport
 * comment describing this cookie as signed is stale; flagged in the OB-015 report
 * rather than edited, since this ticket does not own transport.
 */

/**
 * `ob_` prefixed and unremarkable. Not `__Host-`, which would be stronger — it pins
 * the cookie to one host with no `Domain` — because `config.session.cookieDomain`
 * exists so a deployment can share a session across `app.` and `api.` subdomains, and
 * the `__Host-` prefix forbids `Domain` outright. A deployment that does not set a
 * domain gets host-only scoping from the browser's default anyway.
 */
export const SESSION_COOKIE_NAME = 'ob_session';

/**
 * How long a session lives: **14 days**, absolute.
 *
 * Absolute rather than sliding. A sliding window has to be written on every request,
 * which turns the read path into a write path for a column almost nothing reads, and
 * it means a stolen cookie stays valid indefinitely as long as the thief keeps using
 * it — the opposite of what the expiry is for.
 *
 * 14 days is chosen against the workload rather than as a round number: bookkeeping is
 * weekly-to-monthly work, so a 24-hour session means re-authenticating every single
 * time, and the reliable consequence of that is users choosing worse passwords and
 * saving them somewhere. Two weeks keeps a fortnightly bookkeeping session logged in
 * while bounding the window on a cookie nobody knows was copied.
 *
 * There is no idle timeout in M1, and that is a decision rather than an omission: an
 * idle timeout defends a shared or unattended device, which is a real threat and one
 * whose acceptable window is a product question (spec §14 has no answer). Absolute
 * expiry plus immediate revocation — the reason D-03 rejected stateless cookies —
 * covers the M1 threat model. `last_seen_at` is maintained (see `LAST_SEEN_THROTTLE_MS`
 * in `auth.repository.ts`) so that adding one later needs no backfill.
 */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * The slice of `config.session` this module needs.
 *
 * Narrower than `Config['session']`, which also carries `secret`. The whole config
 * object would be assignable, and taking only these two means the session secret is
 * not reachable from the auth module at all — the cookie is not signed and the token
 * is not keyed, so there is nothing here a secret belongs in.
 */
export interface SessionCookieConfig {
  readonly cookieSecure: boolean;
  readonly cookieDomain?: string;
}

/**
 * Cookie attributes, shaped to be passed straight to `reply.setCookie`.
 *
 * `sameSite` is the literal `'lax'` rather than `string` so it satisfies
 * `@fastify/cookie`'s own option type at the call site without a cast.
 */
export interface SessionCookieOptions {
  readonly httpOnly: true;
  readonly secure: boolean;
  readonly sameSite: 'lax';
  readonly path: '/';
  /** Seconds, per RFC 6265. `0` expires the cookie immediately. */
  readonly maxAge: number;
  readonly domain?: string;
}

export interface SessionCookie {
  readonly name: string;
  readonly value: string;
  readonly options: SessionCookieOptions;
}

/**
 * `SameSite=Lax`, not `Strict`. A session cookie dropped on a top-level navigation
 * from an email link logs the user out for no security benefit; CSRF on this API is
 * addressed by requiring a JSON content type and an `Idempotency-Key` on writes.
 *
 * `Secure` comes from config because plain-HTTP local development is the one case that
 * needs it off, and `src/config/env.ts` defaults it to on so that turning it off is an
 * explicit act.
 */
function options(config: SessionCookieConfig, maxAgeSeconds: number): SessionCookieOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
    // Spread rather than `domain: config.cookieDomain`, because
    // exactOptionalPropertyTypes distinguishes an absent key from one set to
    // `undefined` — and `Domain: undefined` serialized by a cookie library is not
    // reliably the same as no `Domain` at all.
    ...(config.cookieDomain === undefined ? {} : { domain: config.cookieDomain }),
  };
}

/** The cookie that establishes a session. `value` is the token, never its digest. */
export function sessionCookie(token: string, config: SessionCookieConfig): SessionCookie {
  return {
    name: SESSION_COOKIE_NAME,
    value: token,
    options: options(config, Math.floor(SESSION_TTL_MS / 1000)),
  };
}

/**
 * The cookie that removes a session from the browser.
 *
 * Sent alongside the revocation, not instead of it. The revocation is what ends the
 * session — a client that ignores this response still cannot use the token — and this
 * only stops the browser from presenting a credential that no longer works.
 *
 * Every attribute must match the cookie being replaced, `Domain` and `Path` included,
 * or the browser treats it as a different cookie and leaves the original in place.
 * That is why this goes through the same `options` function.
 */
export function clearedSessionCookie(config: SessionCookieConfig): SessionCookie {
  return { name: SESSION_COOKIE_NAME, value: '', options: options(config, 0) };
}

/**
 * A request carrying parsed cookies.
 *
 * Structurally a supertype of `FastifyRequest`, rather than the type itself, for the
 * boundary reason: `.dependency-cruiser.cjs` forbids `src/modules/` from importing
 * `src/transport/`, and while `fastify` is not transport, naming `FastifyRequest` in a
 * service signature is the same coupling one import away. This says what is actually
 * read — a cookie jar — so the identity resolver is callable from a test, and from any
 * future transport, with an object rather than a request.
 */
export interface CookieCarrier {
  readonly cookies: { readonly [name: string]: string | undefined };
}

/**
 * The session token from the request, or `undefined`.
 *
 * An empty cookie is `undefined` and not `''`: a browser that has been sent
 * `clearedSessionCookie` may present `ob_session=` until it prunes it, and that is the
 * absence of a credential, not a credential to reject.
 */
export function readSessionToken(request: CookieCarrier): string | undefined {
  const value = request.cookies[SESSION_COOKIE_NAME];
  return value === undefined || value === '' ? undefined : value;
}
