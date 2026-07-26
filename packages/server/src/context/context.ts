import type { ActorType, InvocationMode, OperationContext } from '@openbooks/plugin-api';
import { randomUUID } from 'node:crypto';

/**
 * The concrete request-scoped context.
 *
 * Deliberately an alias of `OperationContext` and not an extension of it. The
 * contract in `@openbooks/plugin-api` already names exactly what a caller is
 * permitted to know about its origin, so a server-side type that added fields
 * would create two contexts and a conversion between them — and the conversion is
 * where an `orgId` gets rewritten. When a genuinely server-only field appears (a
 * request deadline, a trace parent), this becomes
 * `interface RequestContext extends OperationContext` and services keep depending
 * on the narrower contract; nothing else changes.
 */
export type RequestContext = OperationContext;

/**
 * What a caller must supply to open a context. Narrower than `RequestContext`:
 * `requestId` is generated when absent, and the two nullable fields default to
 * null rather than to a value.
 */
export interface RequestContextInit {
  /** Generated when absent. Supplied by the HTTP layer from an inbound trace header. */
  readonly requestId?: string;
  readonly orgId: string;
  readonly roleId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  /** Null for automation and agent callers not acting as an org member. */
  readonly userId?: string | null;
  /** Absent means unrecorded, which is not `interactive` (plugin-api `ActorProvenance`). */
  readonly invocationMode?: InvocationMode;
  readonly idempotencyKey?: string | null;
}

/**
 * Builds a context.
 *
 * Frozen for the same reason the config object is: `readonly` is a compile-time
 * promise, and this object is handed to pino's mixin, will be handed to a Fastify
 * decorator, and is captured by every async continuation in the request. A
 * mutable `orgId` on a value shared that widely is the failure mode A5 and A7
 * exist to prevent — changing scope must mean opening a new scope, not writing to
 * the old one.
 */
export function createRequestContext(init: RequestContextInit): RequestContext {
  return Object.freeze({
    requestId: init.requestId ?? randomUUID(),
    orgId: init.orgId,
    userId: init.userId ?? null,
    roleId: init.roleId,
    actorType: init.actorType,
    actorId: init.actorId,
    idempotencyKey: init.idempotencyKey ?? null,
    // Spread, so that "unrecorded" is an absent key rather than an explicit
    // `undefined` (exactOptionalPropertyTypes).
    ...(init.invocationMode === undefined ? {} : { invocationMode: init.invocationMode }),
  });
}
