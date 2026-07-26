import type { ActorProvenance } from './actor';

/**
 * Everything a module operation is permitted to know about its caller.
 *
 * Deliberately holds no database handle and no transport object. Modules reach
 * data through registered services only (spec §2.4, §4), and the same operation
 * has to be callable from REST, from an MCP tool, and from the M6 workflow
 * engine — anything Fastify-shaped in here would quietly make one transport the
 * privileged one.
 *
 * `orgId` arrives here and never in an operation's input. That is the contract's
 * half of Phase 0's "a query without org scope is impossible to construct": no
 * input shape carries an org, so asking for a different org's data is not
 * expressible, regardless of what the caller sends. OB-013 enforces the other
 * half at the query builder.
 *
 * OB-009 owns the AsyncLocalStorage carrier; this is the subset of it a module
 * may depend on, so the two are expected to widen independently.
 */
export interface OperationContext extends ActorProvenance {
  readonly requestId: string;
  readonly orgId: string;
  /** Null for automation and agent callers that are not acting as an org member. */
  readonly userId: string | null;
  readonly roleId: string;
  /**
   * Spec §12 requires an idempotency key on every write. The type cannot say
   * "present for writes, absent for reads"; `RouteDefinition.requiresIdempotencyKey`
   * declares the requirement and the idempotency service (OB-017) enforces it.
   * Domain services never read this — idempotency wraps an operation rather than
   * being a parameter of one.
   */
  readonly idempotencyKey: string | null;
}
