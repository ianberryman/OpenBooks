import { NotFoundError } from './errors';

/**
 * Turns "the query returned no row" into the one error that case is allowed to
 * produce (A7 — see the commentary on `NotFoundError`).
 *
 * The reason this is a helper rather than an `if` at each call site is
 * uniformity: every lookup miss in the system throws the same error with the
 * same payload, so the cross-org miss and the genuine miss cannot drift apart
 * later through two independently-worded throws.
 */
export function assertFound<T>(value: T | null | undefined, resource: string): NonNullable<T> {
  if (value === null || value === undefined) throw new NotFoundError(resource);
  return value;
}

/**
 * The org check for the few reads that legitimately bypass `tenantDb` — a
 * `systemDb` join, a row reached by a globally-unique surrogate id.
 *
 * Throws `NotFoundError`, never `PermissionDeniedError`. This is the one place in
 * the codebase where code holds a row it can see belongs to another org, so it is
 * the one place where A7 could be lost by writing the obvious thing. It is a
 * single function precisely so that "the obvious thing" is calling this.
 */
export function assertOrgMatch(expectedOrgId: string, rowOrgId: string, resource: string): void {
  if (expectedOrgId !== rowOrgId) throw new NotFoundError(resource);
}
