/**
 * Actor provenance (spec §6).
 *
 * All three actor types exist in the contract from M1 even though only the user
 * path has code, because attribution cannot be retrofitted onto an append-only
 * ledger — by the time an automation exists, the journals it should have been
 * distinguishable from are already written and unamendable (spec §2.2).
 */
export const ACTOR_TYPES = ['user', 'automation', 'agent'] as const;

export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Whether a human was present. Separate from `actorType` because the two are
 * independent: an agent can act inside an interactive session, and a person's
 * saved automation runs with nobody watching. Spec §6 gates confirmation and
 * propose-only behaviour on this distinction, so collapsing it into `actorType`
 * would lose the thing the gate is made of.
 */
export const INVOCATION_MODES = ['interactive', 'scheduled'] as const;

export type InvocationMode = (typeof INVOCATION_MODES)[number];

export interface ActorProvenance {
  readonly actorType: ActorType;
  /** Opaque to the contract: a user id, an automation id, or an agent session id. */
  readonly actorId: string;
  /** Absent means unrecorded, which is not the same as `interactive`. Do not default it. */
  readonly invocationMode?: InvocationMode;
}

export function isActorType(value: string): value is ActorType {
  return ACTOR_TYPES.includes(value as ActorType);
}

export function isInvocationMode(value: string): value is InvocationMode {
  return INVOCATION_MODES.includes(value as InvocationMode);
}
