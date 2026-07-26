import { InternalError } from '../errors';

/**
 * Thrown when context is read outside a context scope.
 *
 * The point of this class is that the alternative is silent. Spec §4 requires
 * `orgId` to travel in the context and never as a parameter, which means every
 * tenant query's scope comes from `getContext().orgId` — and a `getStore()` that
 * returned `undefined` would make that `undefined.orgId`, or worse,
 * `where org_id = ?` bound to `undefined` and a driver that helpfully coerces it.
 * A5 says an unscoped query must be impossible to construct; a context read that
 * can quietly produce a non-value is a hole in that, so the read throws.
 *
 * An `InternalError` (500), not a 4xx: reaching this means a caller entered
 * service code without opening a scope, which is a wiring bug in the process, not
 * anything the client did.
 */
export class ContextUnavailableError extends InternalError {
  constructor(operation: string) {
    super(
      `${operation} was called outside a request context. Every entry point must open ` +
        'one with runInContext() — the HTTP layer per request, the worker per job, MCP ' +
        'per tool call (spec §4).',
    );
  }
}
