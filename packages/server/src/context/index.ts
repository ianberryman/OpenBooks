/**
 * Request-scoped context (spec §4).
 *
 * `orgId` lives here and never in an operation's parameters, so asking for
 * another org's data is not expressible in any service signature. See `store.ts`
 * for the AsyncLocalStorage decision and the per-org re-scoping rule for
 * background jobs.
 */
export type { RequestContext, RequestContextInit } from './context';
export { createRequestContext } from './context';

export { ContextUnavailableError } from './errors';

export type { ContextOverrides } from './store';
export {
  deriveContext,
  getContext,
  hasContext,
  runInContext,
  runInDerivedContext,
  tryGetContext,
} from './store';
