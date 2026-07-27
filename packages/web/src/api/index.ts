/**
 * The public face of the generated client. Everything outside `src/api/` imports from
 * here, so `schema.d.ts` — which is generated and 1,700 lines long — is referenced by
 * name in exactly one place per concern.
 */
export { api, createApiClient, MissingIdempotencyKeyError } from './client';
export { ApiError, expectNoContent, unwrap } from './errors';
export type { ApiErrorBody, ApiErrorCode } from './errors';
export { presentApiError } from './presentation';
export type { ErrorRecovery, PresentedError } from './presentation';
export { idempotencyHeader, IDEMPOTENCY_KEY_HEADER, newIdempotencyKey } from './idempotency';
export type { IdempotentVariables } from './idempotency';

/**
 * Request and response shapes, straight from `openapi.json`. A screen names what it needs
 * as `components['schemas']['Account']`; there is no hand-written mirror of these types
 * anywhere in this package, and adding one would be a second contract.
 */
export type { components, operations, paths } from './schema';
