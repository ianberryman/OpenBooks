import type { ActorType, InvocationMode, OperationContext } from '@openbooks/plugin-api';
import { randomUUID } from 'node:crypto';

// `../modules/permissions/catalog` and not the `modules/permissions` barrel: the
// barrel re-exports `permissions.service.ts`, which imports `../../context` —
// going through it here would be a cycle. `catalog.ts` depends on nothing but
// `@openbooks/plugin-api`, so importing it directly is acyclic, and it is where
// `PermissionKey` is actually declared regardless of which door a caller uses.
import type { PermissionKey } from '../modules/permissions/catalog';

/**
 * The concrete request-scoped context.
 *
 * An extension of `OperationContext` rather than an alias of it, since OB-098:
 * `scopeLimit` below is exactly the "genuinely server-only field" this comment
 * used to say would trigger the change — an OAuth token's scope∩role ceiling
 * (D-54/F2) is server-side authorization state with no meaning to a module
 * written against `@openbooks/plugin-api` alone, so it does not belong in the
 * contract package (spec §8: modules build against the plugin-api surface only).
 * Everything else about the shape is unchanged: `orgId` still arrives here and
 * nowhere else, and every field `OperationContext` names is still required.
 */
export interface RequestContext extends OperationContext {
  /**
   * The permission ceiling an OAuth token imposes on top of its granting user's
   * role. Absent for a session or an API key context — both trust the role alone —
   * so `permissionsForContext` (`modules/permissions/permissions.service.ts`)
   * treats an absent `scopeLimit` as "no narrowing" and an empty array as "narrowed
   * to nothing", which are different states and must stay distinguishable.
   */
  readonly scopeLimit?: readonly PermissionKey[];
}

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
  /** See `RequestContext.scopeLimit`. Absent for every caller but the OAuth resolver. */
  readonly scopeLimit?: readonly PermissionKey[];
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
    ...(init.scopeLimit === undefined ? {} : { scopeLimit: init.scopeLimit }),
  });
}
