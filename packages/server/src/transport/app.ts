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
import type { IdentityResolver } from './context';
import {
  REQUEST_ID_RESPONSE_HEADER,
  identityOverrides,
  initialContext,
  readIdempotencyKeyOrFailure,
  resolveRequestId,
} from './context';
import { createErrorHandler, createNotFoundHandler } from './errors';
import { registerHealthRoute } from './health';
import { registerOpenApi } from './openapi';
import type { App } from './types';

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
   * Hook order is the load-bearing part of this function, and all of it must
   * precede route registration: Fastify assembles a route's hook chain from the
   * instance's hooks, so a hook added after a route does not run for it.
   *
   * 1. Open the context scope. `runInContext(context, done)` works because
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
   * 2. Authenticate, and re-scope. Second so that the derived context inherits the
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
   * 3. Request logging, inside the scope and after authentication, so both lines
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

  await app.register(cookie, {
    /**
     * Signed cookies for OB-015's session. The secret is validated at ≥32
     * characters by the config schema, so there is no weak-key case to handle
     * here.
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

  // Before routes — see `registerOpenApi`.
  await registerOpenApi(app);

  app.setErrorHandler(createErrorHandler(logger));
  app.setNotFoundHandler(createNotFoundHandler(logger));

  registerHealthRoute(app);

  return app;
}
