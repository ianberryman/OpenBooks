import { newIdempotencyKey } from '../../api';

/**
 * One idempotency key per *thing being done to*, not per click.
 *
 * ## What this is for
 *
 * The header exists so that a retry carries the **same** key: that is how the server
 * tells "the user asked twice" from "the network dropped the response and the client
 * asked again" (`src/api/idempotency.ts`). Posting a draft is the case where getting
 * that wrong is unrecoverable — `postDraft` posts the journal and deletes the draft in
 * one transaction (D-19), and a second key would be a second claim, a second journal,
 * and no draft left to notice it with. The ticket's requirement is exactly this: one
 * key minted per draft, not per click.
 *
 * A `useRef` in the editor would nearly do it, and the gap is worth stating: the editor
 * remounts when the user navigates away from a draft and back, and a fresh ref would
 * mint a fresh key for a draft that already has one. Holding the key against the
 * resource id instead makes it survive whatever the UI does between the two clicks.
 *
 * ## Why a shared key is safe here and would not be everywhere
 *
 * `postDraft` fingerprints `{ draftId }` alone (`transport/routes/drafts.ts`), so the
 * request is *the same request* however much the draft has been edited between
 * attempts, and reusing the key is a replay rather than an
 * `idempotency_key_conflict`. Draft *saves* do not work that way — they fingerprint the
 * patch — so each save mints its own key at the point the user commits it.
 *
 * A failed attempt does not burn the key: the claim rolls back with the operation
 * ("a failure is not poison", `modules/idempotency/service.ts`), which is what makes a
 * refused post leave the draft intact *and* postable with the key it already had.
 */
const keys = new Map<string, string>();

function keyOf(operation: string, resourceId: string): string {
  return `${operation}:${resourceId}`;
}

export function idempotencyKeyFor(operation: string, resourceId: string): string {
  const id = keyOf(operation, resourceId);
  const existing = keys.get(id);
  if (existing !== undefined) return existing;

  const minted = newIdempotencyKey();
  keys.set(id, minted);
  return minted;
}

/**
 * Dropped once the resource is gone, because nothing can be retried against it any
 * more. Not an optimization — a key kept against a deleted draft id is a key that would
 * be reused if that id were ever reissued.
 */
export function releaseIdempotencyKey(operation: string, resourceId: string): void {
  keys.delete(keyOf(operation, resourceId));
}
