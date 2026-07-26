import type {
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { Logger } from '../logging';

/**
 * The Fastify instance every module in this directory speaks to.
 *
 * It lives in its own file rather than in `app.ts` because the route and plugin
 * modules need the type and `app.ts` needs them — importing it from `app.ts`
 * would be a cycle, and `.dependency-cruiser.cjs` counts type-only edges
 * (`tsPreCompilationDeps: true`), so the cycle would fail `yarn lint:deps`
 * rather than merely being untidy.
 *
 * `ZodTypeProvider` is baked into the alias, so a route registered on an `App`
 * infers its handler's input and reply types from the Zod schemas rather than
 * from `unknown`. A plain `FastifyInstance` would compile and silently lose that.
 *
 * The logger parameter is pino's `Logger` and not Fastify's `FastifyBaseLogger`:
 * `buildApp` passes a real pino instance as `loggerInstance` (so the provenance
 * mixin in `src/logging/` applies to Fastify's own lines too), and Fastify infers
 * the narrower type from it. Widening it here makes the inferred instance
 * unassignable to this alias, because `childLoggerFactory` is contravariant in it.
 */
export type App = FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  Logger,
  ZodTypeProvider
>;
