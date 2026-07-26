import type { ActorType, InvocationMode } from '@openbooks/plugin-api';
import type { RequestContext } from '../context';

/**
 * The provenance fields every log line carries (spec §12, A13).
 *
 * A type alias rather than an interface so it has TypeScript's implicit index
 * signature and can be handed to pino's mixin, which is typed as returning an
 * object of unknown shape.
 *
 * Flat rather than nested under an `actor` key: log queries filter on
 * `orgId = …` and `requestId = …` constantly, and every aggregator makes a
 * top-level field cheaper to index and shorter to write than a nested path.
 */
export type LogProvenance = {
  readonly requestId: string;
  readonly orgId: string;
  readonly userId: string | null;
  readonly roleId: string;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly invocationMode?: InvocationMode;
};

/**
 * Projects a context onto its log fields.
 *
 * `idempotencyKey` is deliberately not included: provenance answers "who did
 * this", and the key is a property of the request, not the actor. OB-017 logs it
 * explicitly where a replay is the thing being described.
 */
export function provenanceOf(context: RequestContext): LogProvenance {
  return {
    requestId: context.requestId,
    orgId: context.orgId,
    userId: context.userId,
    roleId: context.roleId,
    actorType: context.actorType,
    actorId: context.actorId,
    // Absent means unrecorded, and plugin-api's `ActorProvenance` is explicit
    // that this must not be defaulted to `interactive`.
    ...(context.invocationMode === undefined ? {} : { invocationMode: context.invocationMode }),
  };
}
