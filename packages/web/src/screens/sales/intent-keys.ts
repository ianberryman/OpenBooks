import { newIdempotencyKey } from '../../api';

/**
 * One idempotency key per *thing being done to*, not per click (OB-068).
 *
 * ## The case this exists for
 *
 * Approving is the irreversible step (D-38): in one transaction it allocates the gapless
 * document number, posts a balanced journal and records both. A second key would be a
 * second claim, and a second claim is a second journal against a document that already
 * has one — so a double-clicked Approve, a retry after a dropped response, and a user who
 * navigated away and came back must all send the key the first attempt sent. That is what
 * the header is *for*: it is how the server tells "the user asked twice" from "the network
 * dropped the response" (`src/api/idempotency.ts`).
 *
 * A `useRef` in the component would nearly do it and the gap is the point: the document
 * view unmounts when the user goes back to the list, and a fresh ref would mint a fresh
 * key for a document that already has one. Holding the key against the resource id
 * instead makes it survive whatever the UI does between the two clicks.
 *
 * ## Why only approve, and not void or save
 *
 * A stable key is safe exactly when the request is *the same request* on every attempt.
 * `approveInvoice` and `approveCreditNote` fingerprint `{ invoiceId }` / `{ creditNoteId }`
 * alone (`transport/routes/invoices.ts`), so a replay is a replay however much time has
 * passed. `voidInvoice` fingerprints the body, which carries the reversal's own date and
 * memo — reusing a key after the user corrected the date would be an
 * `idempotency_key_conflict` rather than the retry they asked for. Void, save, create and
 * discard therefore mint at the point the user commits, once per submission.
 *
 * A failed attempt does not burn the key: the claim rolls back with the operation, which
 * is what makes a refused approval leave the document a draft *and* approvable with the
 * key it already had.
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
 * Dropped once the intent is spent — the document has been approved, or discarded and no
 * longer exists. Not an optimization: a key held against an id that is gone is a key that
 * would be reused if that id were ever reissued.
 */
export function releaseIdempotencyKey(operation: string, resourceId: string): void {
  keys.delete(keyOf(operation, resourceId));
}

export const APPROVE_DOCUMENT = 'approveDocument';
