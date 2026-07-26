import type { ActorType, InvocationMode } from '@openbooks/plugin-api';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestContext } from './context';
import { createRequestContext } from './context';
import { ContextUnavailableError } from './errors';

/**
 * Request-scoped context, spec §4.
 *
 * ## Why `AsyncLocalStorage` and not `@fastify/request-context`
 *
 * `@fastify/request-context` is already a dependency and is not used here. Three
 * reasons, in order of weight:
 *
 * 1. **The context has non-HTTP callers, by design.** Spec §2.4 puts one service
 *    layer behind many transports: the worker role runs jobs today and MCP tool
 *    handlers call the same services in M5 (spec §8), neither of which has a
 *    Fastify request. `@fastify/request-context`'s only way in is an `onRequest`
 *    hook on a Fastify instance, so a worker would have to either fabricate a
 *    request or reach into the plugin's internal storage. A context that is
 *    awkward to enter from the worker is a context the worker will skip, and a job
 *    that skips it processes rows unscoped — exactly what §4 forbids.
 *
 * 2. **It models the context as a mutable bag.** Its API is `get(key)` /
 *    `set(key, value)`, so `orgId` can change under a running operation. That is
 *    not a hypothetical: an org-switch handler (OB-015) is precisely the code that
 *    would reach for `set('orgId', …)`, and a half-completed operation would then
 *    read two different orgs from the same context. Storing one frozen object and
 *    requiring a *new scope* to change scope makes that impossible to express.
 *
 * 3. **It adds no capability.** It is a thin wrapper over this same
 *    `AsyncLocalStorage` with a Fastify-shaped door. OB-022 still registers a
 *    Fastify hook — the hook just calls `runInContext` here, which is a smaller
 *    integration than adopting a second context mechanism whose lifetime rules we
 *    would have to reconcile with this one.
 *
 * The dependency stays in `package.json`; removing it means editing a
 * `package.json`, which this ticket may not do.
 */
const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` inside a fresh context scope. This is the entry point every transport
 * calls: the HTTP layer once per request, the worker once per job, an MCP handler
 * once per tool call.
 *
 * Generic in the return type and not `async`, so it wraps sync and async work
 * alike — `AsyncLocalStorage` propagates across every `await` inside `fn`, into
 * timers, and into promise callbacks, which is the whole reason it is safe to
 * hold `orgId` here while requests interleave.
 */
export function runInContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The context, or a thrown `ContextUnavailableError`. Callers that need scope —
 * every tenant query — use this.
 */
export function getContext(operation = 'getContext()'): RequestContext {
  const context = storage.getStore();
  if (context === undefined) throw new ContextUnavailableError(operation);
  return context;
}

/**
 * The context if there is one.
 *
 * Only for code that is legitimately callable both inside and outside a scope,
 * which in practice means the logger: boot and shutdown lines have no request to
 * be provenanced against, and a logger that threw during startup would replace a
 * config error with a context error. Anything that reaches the database uses
 * `getContext()`.
 */
export function tryGetContext(): RequestContext | undefined {
  return storage.getStore();
}

export function hasContext(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Fields a derived scope may replace. Every field is optional; `undefined` means
 * "inherit", which is why the nullable fields are compared against `undefined`
 * rather than coalesced — an explicit `userId: null` is an override to null, not
 * an absence.
 */
export interface ContextOverrides {
  readonly requestId?: string;
  readonly orgId?: string;
  readonly userId?: string | null;
  readonly roleId?: string;
  readonly actorType?: ActorType;
  readonly actorId?: string;
  readonly invocationMode?: InvocationMode;
  readonly idempotencyKey?: string | null;
}

function inherit<T>(override: T | undefined, parent: T): T {
  return override === undefined ? parent : override;
}

/**
 * A context derived from the current one.
 *
 * Requires a current scope, so a derived context always carries a real
 * `requestId` and actor forward — the provenance chain is preserved rather than
 * re-invented.
 */
export function deriveContext(overrides: ContextOverrides): RequestContext {
  const parent = getContext('deriveContext()');

  const invocationMode = inherit(overrides.invocationMode, parent.invocationMode);

  return createRequestContext({
    requestId: inherit(overrides.requestId, parent.requestId),
    orgId: inherit(overrides.orgId, parent.orgId),
    userId: inherit(overrides.userId, parent.userId),
    roleId: inherit(overrides.roleId, parent.roleId),
    actorType: inherit(overrides.actorType, parent.actorType),
    actorId: inherit(overrides.actorId, parent.actorId),
    idempotencyKey: inherit(overrides.idempotencyKey, parent.idempotencyKey),
    ...(invocationMode === undefined ? {} : { invocationMode }),
  });
}

/**
 * Runs `fn` in a scope derived from the current one.
 *
 * This is the mechanism behind spec §4's rule that a background job re-scopes per
 * row and never processes a cross-org batch unscoped. A job that has fetched work
 * for several orgs wraps each row:
 *
 * ```ts
 * for (const row of rows) {
 *   await runInDerivedContext({ orgId: row.orgId }, () => handle(row));
 * }
 * ```
 *
 * The alternative — one scope for the batch — cannot be written by accident,
 * because there is no org to open the batch scope *with*: `orgId` is required by
 * `createRequestContext`, so "the whole batch, unscoped" is not a context that
 * exists.
 */
export function runInDerivedContext<T>(overrides: ContextOverrides, fn: () => T): T {
  return storage.run(deriveContext(overrides), fn);
}
