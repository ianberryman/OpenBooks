/**
 * CORS, for the hosted split only (OB-029; M1 known gap 2).
 *
 * `@fastify/cors` is the mechanism. This file is the configuration, and every option
 * below is a departure from the plugin's defaults — those are a wildcard origin with
 * no credentials and `GET,HEAD,POST`, which describes the opposite deployment to this
 * one. The two departures that are *not* option values are the placement of
 * `registerCors` in `buildApp` and the shape of the `origin` callback; both are
 * explained where they are made.
 *
 * The hosted layout serves the web bundle from CloudFront and the API from its own
 * hostname, so every call the browser makes is cross-origin. Nothing else needs this:
 * the Compose stack, a reverse-proxied self-host, and M2's Vite dev proxy are all
 * same-origin, `config.cors.enabled` is false for all three, and the early return
 * below registers no plugin at all — no hooks, no decorator, and no wildcard
 * `OPTIONS` route, so the hook chain is byte-identical to the one that ran before
 * this ticket.
 *
 * ## Why a preflight is not optional here
 *
 * Spec §12 requires an `Idempotency-Key` on every write. That header is not on the
 * CORS-safelist, and neither is `Content-Type: application/json`, so *every* write
 * this API accepts triggers a preflight — there is no such thing as a "simple" write
 * against this surface. An allowlist that omits `Idempotency-Key` therefore does not
 * degrade gracefully; it fails 100% of writes while reads keep working, which is the
 * shape of bug that gets diagnosed as "the ledger is broken".
 *
 * ## Refusal is the absence of the headers, never a status
 *
 * A disallowed origin gets a response with no `Access-Control-*` headers, and the
 * browser discards it. It is tempting to answer 403 instead, but a status would be
 * both wrong and useless: wrong because `Origin` is not a credential — `curl`, the
 * MCP surface (M5), and every server-to-server integrator send none or send their
 * own, and refusing on it would break callers CORS was never about — and useless
 * because no code ever reads a preflight's body. The refusal is instead made
 * *visible where it can be acted on*, by the `warn` below.
 *
 * This does not weaken CSRF. A cross-site write cannot be issued by a browser at
 * all: it needs a preflight (see above), the preflight is refused, and the request is
 * never sent. A cross-site read is issued, but `SameSite=Lax` withholds the session
 * cookie from it, so it is answered as an unauthenticated request and the browser
 * then discards the answer anyway.
 *
 * ## What is validated elsewhere
 *
 * The allowlist itself is checked by `corsIssues` in `src/config/env.ts`, not here.
 * What it checks is a relationship with `SESSION_COOKIE_DOMAIN` — an origin the
 * `SameSite=Lax` session cookie can never reach is a deployment where the preflight
 * passes and every request is a 401 — which is a fact about this system's cookie, not
 * about CORS, and so is not the plugin's to know.
 */
import cors from '@fastify/cors';

import type { CorsConfig } from '../config';
import type { Logger } from '../logging';
import { REQUEST_ID_RESPONSE_HEADER } from './context';
import { IDEMPOTENCY_KEY_HEADER } from './idempotency';
import type { App } from './types';

/**
 * `idempotency-key` is the one this ticket exists for. `content-type` is here because
 * `application/json` is outside the safelist's three values, and `x-request-id`
 * because `src/transport/context.ts` accepts an inbound correlation id and a header
 * the API documents as accepted but rejects at the preflight is a contradiction.
 * `cookie` is deliberately absent: it is a forbidden header name, set by the browser
 * and never by `fetch`, and listing it would suggest the credential flows through
 * this allowlist rather than through `Access-Control-Allow-Credentials`.
 *
 * Stated explicitly rather than left `null`, which is the plugin's default and means
 * "reflect whatever `Access-Control-Request-Headers` asked for" — an allowlist that
 * allows everything, and one whose contents are then invisible in a test.
 */
const ALLOWED_REQUEST_HEADERS = ['content-type', IDEMPOTENCY_KEY_HEADER, 'x-request-id'];

/**
 * `x-request-id` is on every response (`src/transport/context.ts`) so a client can
 * quote it in a support request. Cross-origin, a response header is unreadable by
 * script unless it is exposed, so without this the correlation id exists on the wire
 * and is invisible to the only party who would ever quote it.
 */
const EXPOSED_RESPONSE_HEADERS = [REQUEST_ID_RESPONSE_HEADER];

/**
 * Every method this API serves today — `HEAD` included, because Fastify registers one
 * for each `GET` — plus `OPTIONS`.
 *
 * Not derived from the route table, and the reason is an ordering one: a preflight is
 * answered before routing, so the derivation would have to run after
 * `registerV1Routes`, which is after this plugin must already be registered. The cost
 * of the literal is that a route registered with a method absent from this list has a
 * working route and a failing preflight — visible only from a browser. M2 adds
 * routes; if one of them is a `PUT`, it is added here.
 */
const ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * Ten minutes. Long enough that a screen doing a burst of writes pays for one
 * preflight rather than one per request, short enough that widening the allowlist
 * takes effect within a coffee break. Chrome caps this at 7200s and Safari at 600s
 * regardless of what is sent, so anything larger is a number that only ever applied
 * to Firefox.
 */
const MAX_AGE_SECONDS = 600;

/**
 * Awaited, and registered from `buildApp` *before* the context hook — the two halves
 * of one decision, and the load-bearing part of this file.
 *
 * `await app.register(...)` is what makes the plugin's `onRequest` hook the first one
 * on the instance; Fastify runs `onRequest` hooks in registration order, and an
 * un-awaited `register` defers the plugin to `ready()` and would put its hook last.
 * Being first is what the placement buys, because the context hook in `app.ts`
 * rejects a malformed `Idempotency-Key` with `done(failure)`, and that skips every
 * *later* `onRequest` hook. Registered after it, the plugin would leave the one
 * response a cross-origin client most needs to read — the 400 explaining that its key
 * is malformed — with no CORS headers, replaced in the console by a generic CORS
 * error. Measured: with the plugin registered after the context hook, that 400 comes
 * back with no `Access-Control-Allow-Origin` at all.
 *
 * The plugin's `hook: 'onSend'` option looks like the alternative that would let this
 * sit later in the chain, and it does not work: the preflight short-circuit calls
 * `reply.code(204).send()` from inside the hook, which by `onSend` is a send on an
 * already-sent reply — `ERR_HTTP_HEADERS_SENT`, and the preflight never answers.
 *
 * What being first costs is scope. A short-circuited preflight is answered before
 * `runInContext` opens, so its 204 carries no `x-request-id` and the `warn` below has
 * no correlation id to attach — the plugin's `origin` callback is handed the origin
 * string and nothing else, so there is no request to read one from either. Both lines
 * still name the origin, which is the fact an operator needs; a preflight that never
 * reaches a handler has nothing else worth correlating.
 */
export async function registerCors(app: App, config: CorsConfig, logger: Logger): Promise<void> {
  if (!config.enabled) return;

  const allowed = new Set(config.allowedOrigins);

  await app.register(cors, {
    /**
     * `false` — not an error — is how the plugin is told to attach nothing, which is
     * the refusal described above. The plugin's plain array form matches identically
     * and would do; a callback is here because the array form has nowhere to log from.
     *
     * No `Origin` at all is `false` too, and silently: that is `curl`, the MCP
     * surface (M5), and every server-to-server integrator, none of which CORS has
     * anything to say about. Answering `true` there would instead route them into the
     * preflight branch on any `OPTIONS`, which is not what a non-browser caller sent.
     */
    origin: (origin, callback) => {
      if (origin === undefined) {
        callback(null, false);
        return;
      }

      if (allowed.has(origin)) {
        callback(null, true);
        return;
      }

      /**
       * `warn` and not `debug`: an origin missing from the allowlist is almost always
       * a deployment that is broken for real users right now, and this is the only
       * signal that says so from the server side.
       *
       * It can fire benignly. A browser sends `Origin` on *same*-origin requests too
       * whenever the method is not GET or HEAD, so an API that also serves its own
       * page logs a line here for traffic that never needed CORS. Harmless — nothing
       * is refused by it, only unlabelled — and worth the false positives, because
       * the alternative is that a misconfigured allowlist is visible only in the
       * console of whoever hits it first.
       */
      logger.warn({ origin }, 'cross-origin request from an origin outside CORS_ALLOWED_ORIGINS');
      callback(null, false);
    },
    // The session is an HttpOnly cookie (D-03, spec §5) and `packages/web`'s client
    // sends `credentials: 'include'`, so without this every request is anonymous.
    credentials: true,
    methods: ALLOWED_METHODS,
    allowedHeaders: ALLOWED_REQUEST_HEADERS,
    exposedHeaders: EXPOSED_RESPONSE_HEADERS,
    maxAge: MAX_AGE_SECONDS,
    /**
     * `strictPreflight` is left at its default `true`, which is the plugin's one
     * visible difference from what this file used to do by hand: an `OPTIONS` carrying
     * an `Origin` but no `Access-Control-Request-Method` is answered 400 rather than
     * falling through to the 404 handler. Kept rather than turned off, because `false`
     * means the opposite — every `OPTIONS` from a known origin is answered as a
     * preflight, which silently shadows any real `OPTIONS` route M5 adds. A test pins
     * the 400 so the day that shadowing matters is a test failure, not a deploy.
     */
  });
}
