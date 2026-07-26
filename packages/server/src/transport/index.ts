/**
 * The HTTP transport (spec §2.4: transport adapters hold zero business logic).
 *
 * `buildApp` is the whole surface for starting the API; the rest of this file is
 * the seams other tickets attach to:
 *
 * - **OB-015 (auth)** implements `IdentityResolver` and passes it to `buildApp`.
 *   Every request already runs inside a context scope carrying a request id before
 *   the resolver is called, and the resolver's result *derives* a new scope rather
 *   than mutating the old one — see `src/transport/context.ts`.
 * - **OB-016 (permissions)** uses `isAuthenticatedContext` to distinguish a request
 *   that never presented credentials from one that did.
 * - **OB-017 (idempotency)** reads the key from `OperationContext.idempotencyKey`,
 *   which the context hook populates from the header. Transport declares no runner
 *   interface of its own — see `src/transport/idempotency.ts` for why.
 * - **OB-023 (routes)** is `src/transport/routes/`, registered by `buildApp` itself.
 *   Read `routes/index.ts` for the route table, what a handler in there may contain,
 *   how the two halves of idempotency are applied at the boundary, and why no
 *   `RouteDefinition` → Fastify adapter was built.
 * - **OB-024 (client)** consumes `openapi.json`, produced by
 *   `src/entrypoints/spec.ts` from `generateOpenApiDocument`.
 */
export type { App } from './types';

export type { BuildAppOptions } from './app';
export { buildApp } from './app';

export type { IdentityResolver, RequestIdentity } from './context';
export { REQUEST_ID_RESPONSE_HEADER, isAuthenticatedContext } from './context';

export { IDEMPOTENCY_KEY_HEADER, readIdempotencyKey, requireIdempotencyKey } from './idempotency';

export type { ErrorResponse } from './schemas';
export { errorResponseSchema, healthResponseSchema } from './schemas';

export { canonicalize, generateOpenApiDocument } from './openapi';
