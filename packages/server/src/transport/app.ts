/**
 * Assembles the Fastify instance.
 *
 * A function returning a configured instance rather than a module that listens on
 * import: `app.inject()` exercises the whole stack — hooks, validation,
 * serialization, error handling — with no port, no socket, and no teardown, which
 * is what makes the transport testable at all. `src/entrypoints/api.ts` is the only
 * caller that binds a port.
 *
 * Nothing here is business logic (spec §2.4). Everything below is one of: a plugin,
 * a lifecycle hook, or a seam another ticket plugs into.
 */
import cookie from '@fastify/cookie';
import Fastify, { LogController } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';

import type { Config } from '../config';
import { runInContext, runInDerivedContext } from '../context';
import type { Logger } from '../logging';
import { createLogger } from '../logging';
import { registerMcpServer } from '../modules/mcp/host';
import type { IdentityResolver } from './context';
import {
  REQUEST_ID_RESPONSE_HEADER,
  identityOverrides,
  initialContext,
  readIdempotencyKeyOrFailure,
  resolveRequestId,
} from './context';
import { registerCors } from './cors';
import { createErrorHandler, createNotFoundHandler } from './errors';
import { registerHealthRoute } from './health';
import { registerOpenApi } from './openapi';
import { registerV1Routes } from './routes';
import { registerArtifactRoutes } from './routes/artifacts';
import { registerOAuthFlowRoutes } from './routes/oauth-flow';
import { registerProcessingWebhookRoutes } from './routes/processing-webhook';
import { registerPublicInvoiceRoutes } from './routes/public-invoices';
import { registerPublicPayLinkRoutes } from './routes/public-pay-link';
import { registerPublicStatementRoutes } from './routes/public-statements';
import type { App } from './types';

/**
 * Routes that establish or destroy a session, and therefore must be reachable despite the
 * cookie the caller arrived with. See the identity hook below for why. Matched on the route
 * template (`request.routeOptions.url`), which is stable across query strings and casing.
 *
 * The two `/public/invoices/*` routes (OB-121, D-74) are here for a related but distinct
 * reason: they carry **no session at all** — the capability token in the path is the whole
 * authorization — and the identity resolver *throws* on a cookie that names a revoked or
 * expired session (`context.ts`: correct for a tenant route, where a forged cookie deserves a
 * 401). A customer opening an emailed invoice link in a browser that also happens to hold a
 * stale `HttpOnly` session cookie from an unrelated login must not be locked out of a page that
 * needs no login at all, so these two skip identity resolution exactly as login/register/logout
 * do, and for the same shape of reason: the incoming cookie, whatever it says, is not this
 * request's business.
 */
const IDENTITY_ESTABLISHING_ROUTES: ReadonlySet<string> = new Set([
  '/v1/auth/login',
  '/v1/auth/register',
  '/v1/auth/logout',
  '/public/invoices/:token',
  '/public/invoices/:token/pdf',
  // The self-host artifact stream (`routes/artifacts.ts`, local adapter only): its
  // consumer is the unauthenticated hosted invoice page's logo, so the unguessable
  // key is the whole authorization, the same shape as the two routes above.
  '/artifacts/*',
]);

export interface BuildAppOptions {
  /**
   * Required rather than defaulted to `getConfig()`.
   *
   * `src/config/index.ts` is explicit that importing config must not validate the
   * environment as a side effect, and a default here would reintroduce that at one
   * remove: `src/entrypoints/spec.ts` emits the document from the route table alone
   * and has no business needing a database password to do it, and neither do the
   * transport tests.
   */
  readonly config: Config;
  /** Defaults to a logger built from `config`. Tests pass one over a capture stream. */
  readonly logger?: Logger;
  /** OB-015. Absent means every request stays in the unauthenticated scope. */
  readonly resolveIdentity?: IdentityResolver;
}

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config);

  const app = Fastify({
    loggerInstance: logger,
    /**
     * Fastify's own request logging is replaced below, not merely reformatted.
     * Its "incoming request" line is emitted from an internal hook that runs
     * before any user `onRequest` hook — therefore before the context scope
     * exists — so pino's provenance mixin (A13) has nothing to read and the line
     * is unattributed. Its lines also come from `request.log`, a child logger
     * whose `reqId` binding duplicates the mixin's `requestId` under a second
     * name, and whose bindings bypass the redaction walk in
     * `src/logging/serialize.ts` (documented there).
     *
     * Set through `logController` rather than the top-level
     * `disableRequestLogging`, which Fastify 5.10 deprecates and removes in 6.
     */
    logController: new LogController({ disableRequestLogging: true }),
    /**
     * Fastify would otherwise adopt an inbound `request-id` header verbatim as
     * `request.id`. `src/transport/context.ts` accepts a correlation id from the
     * client but validates its length and charset first, because the value
     * reaches every log line and a response header.
     */
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  /**
   * `@fastify/cookie` first, before any hook of ours.
   *
   * It parses the `Cookie` header in an `onRequest` hook of its own and leaves
   * `request.cookies` as the `null` its decorator declares until that hook has run.
   * Fastify runs `onRequest` hooks in the order they were added, and `addHook` calls
   * made here run synchronously while `await app.register(...)` completes the plugin's
   * own registration — so calling it *after* the hooks below would put its parse hook
   * last, and the identity resolver (step 3) would read `null` and fail with a
   * `TypeError` on every request. Found by OB-023 the moment a resolver was wired in;
   * before that nothing read a cookie and the ordering was invisible.
   */
  await app.register(cookie, {
    /**
     * The secret enables signing *support*; the session cookie itself is
     * deliberately unsigned.
     *
     * A signature would make `SESSION_SECRET` a second authority on whether a
     * session is live, so rotating it would log everyone out while the `sessions`
     * table still said otherwise — the opposite of why sessions are server-side
     * (D-03). The token is 32 random bytes and its liveness comes from a row
     * lookup, which a signature cannot improve on. Kept configured so a future
     * cookie that genuinely needs tamper-evidence without a database read (a CSRF
     * double-submit token, say) has it available.
     */
    secret: config.session.secret,
    parseOptions: {
      httpOnly: true,
      secure: config.session.cookieSecure,
      // `lax` and not `strict`: a session cookie that is dropped on a top-level
      // navigation from an email link logs the user out for no security benefit,
      // and CSRF on this API is addressed by requiring a JSON content type and an
      // `Idempotency-Key` on writes rather than by cookie policy alone.
      sameSite: 'lax',
      path: '/',
      ...(config.session.cookieDomain === undefined ? {} : { domain: config.session.cookieDomain }),
    },
  });

  /**
   * Hook order is the load-bearing part of this function, and all of it must
   * precede route registration: Fastify assembles a route's hook chain from the
   * instance's hooks, so a hook added after a route does not run for it.
   *
   * 1. CORS, when a deployment has declared cross-origin callers (OB-029).
   *    Registers nothing when `config.cors.enabled` is false, which is every
   *    same-origin deployment. First, and `src/transport/cors.ts` explains why
   *    it has to be: the hook below can reject a request, and everything after a
   *    rejection is skipped.
   */
  await registerCors(app, config.cors, logger);

  /**
   * 2. Open the context scope. `runInContext(context, done)` works because
   *    Fastify's hook runner invokes the next step synchronously from `done()`,
   *    so the remainder of the request lifecycle runs nested inside the
   *    `AsyncLocalStorage.run()` call and inherits the scope across every
   *    subsequent `await`. This is the same mechanism `@fastify/request-context`
   *    uses; `src/context/store.ts` explains why we call `runInContext` directly
   *    rather than adopt that plugin.
   */
  app.addHook('onRequest', (request, reply, done) => {
    const requestId = resolveRequestId(request);
    // Echoed so a client can quote it in a support request and so a proxy's log and
    // ours can be joined. Set first, so every response carries it — including the
    // rejection two lines down.
    void reply.header(REQUEST_ID_RESPONSE_HEADER, requestId);

    // The `Idempotency-Key` can reject the request, and `done(failure)` rather than
    // a throw is what keeps that rejection inside the scope: the hook runner's error
    // path is invoked synchronously from `done`, so the error handler's log line
    // still carries provenance. A throw here would unwind out of `runInContext`
    // first and produce the one log line in the system with no `requestId`.
    const { key, failure } = readIdempotencyKeyOrFailure(request);

    runInContext(initialContext(requestId, key), () => {
      done(failure);
    });
  });

  /**
   * 3. Authenticate, and re-scope. Second so that the derived context inherits the
   *    `requestId` established above rather than minting a new one, and so an
   *    authentication failure is already inside a scope and therefore logged with a
   *    correlation id.
   *
   *    `runInDerivedContext` is the only way to change scope — `src/context/`
   *    stores one frozen object per scope precisely so an org-switch cannot mutate
   *    the context of a half-completed operation.
   */
  const { resolveIdentity } = options;
  if (resolveIdentity !== undefined) {
    app.addHook('onRequest', (request, _reply, done) => {
      // The identity-establishing routes ignore the incoming session entirely.
      //
      // The resolver *throws* on a presented-but-invalid session cookie by design
      // (`context.ts`: a forged cookie is worth a 401 on a tenant route). But that hook
      // runs before every route, so a stale or revoked `HttpOnly` cookie would 401 the
      // exact routes that exist to clear it — login, register, logout — and the browser
      // cannot clear an `HttpOnly` cookie itself. The result is a lockout with no way
      // back in. These three routes do not need the incoming identity: login and register
      // replace the session, and logout's own contract is that it "succeeds whether or not
      // the cookie names a live session". So they skip resolution and run in the pre-auth
      // scope, and the session they establish overwrites whatever cookie arrived.
      if (IDENTITY_ESTABLISHING_ROUTES.has(request.routeOptions.url ?? '')) {
        done();
        return;
      }
      resolveIdentity(request).then((identity) => {
        if (identity === null) {
          done();
          return;
        }
        runInDerivedContext(identityOverrides(identity), done);
      }, done);
    });
  }

  /**
   * 4. Request logging, inside the scope and after authentication, so both lines
   *    carry actor provenance from the mixin. Nothing is attached by hand here —
   *    `requestId`, `orgId`, `userId`, `roleId`, `actorType`, and `actorId` come
   *    from `provenanceOf(context)` via pino's `mixin` (A13, `src/logging/`), and
   *    the merge strategy there makes provenance win over anything a call site
   *    passes, so re-attaching it would be both redundant and a way to lie.
   */
  app.addHook('onRequest', (request, _reply, done) => {
    logger.debug({ method: request.method, url: request.url }, 'request received');
    done();
  });

  app.addHook('onResponse', (request, reply, done) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });

  // Before routes — see `registerOpenApi`.
  await registerOpenApi(app);

  app.setErrorHandler(createErrorHandler(logger));
  app.setNotFoundHandler(createNotFoundHandler(logger));

  registerHealthRoute(app);
  // Outside `/v1` and outside the permission surface entirely (OB-121, D-74): the
  // one sanctioned unauthenticated read on the API. See `public-invoices.ts`'s file
  // header for why these two live here rather than inside `registerV1Routes`.
  registerPublicInvoiceRoutes(app);
  // The pay-link the hosted page's "Pay now" button opens (OB-150, D-82…D-86): the
  // same unauthenticated shape as the route above, registered alongside it for the
  // reason `public-pay-link.ts`'s file header gives.
  registerPublicPayLinkRoutes(app, config);
  // The hosted customer-statement PDF (OB-220 part 1): the same unauthenticated,
  // token-is-the-authorization shape as the two routes above, at
  // `/public/statements/{token}/pdf` so it shares their `/public/*` proxy rule.
  registerPublicStatementRoutes(app);
  // A third unauthenticated surface, alongside the two above (OB-148, D-85): the
  // signed, session-less inbound payment-processor webhook. See
  // `routes/processing-webhook.ts`'s file header for why it lives here, outside
  // `/v1`, and why it does not use the global `Idempotency-Key` middleware.
  registerProcessingWebhookRoutes(app);
  // Local-adapter only, and hidden from `openapi.json`: the retrieval path the local
  // StorageProvider's `signedUrl` points at. Registers nothing under s3 (`artifacts.ts`).
  registerArtifactRoutes(app, config);
  // OAuth 2.1's own RFC 6749/7009 wire endpoints (OB-098, OB-104; D-53, D-54, D-61):
  // `authorize`, `consent`, `token`, `revoke`. Outside `/v1` and outside the typed
  // envelope, for the same shape of reason as the two routes above — see
  // `oauth-flow.ts`'s file header. `/v1/oauth-clients` and `/v1/connected-apps`
  // (this project's own JSON management routes over the same service) register
  // inside `registerV1Routes` below, as usual.
  registerOAuthFlowRoutes(app);
  // The MCP host (OB-103, OB-104; D-59): `POST /mcp`, mounted in-process on the same
  // `api` role rather than a fourth process. Hidden from `openapi.json` — `tools/list`
  // is this surface's own documentation, `mcp/host.ts`'s file header explains why.
  registerMcpServer(app);
  // Registration order is not load-bearing: `canonicalize` sorts the document's keys,
  // so moving a route or splitting a file cannot change `openapi.json` (see
  // `./openapi.ts`). It is alphabetical inside `registerV1Routes` for readers only.
  registerV1Routes(app, config);

  return app;
}
