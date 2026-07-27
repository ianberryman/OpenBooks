import { useCallback, useRef } from 'react';

import { newIdempotencyKey } from '../../api';

/**
 * One `Idempotency-Key` per user *intent*, and the two shapes an intent takes on this
 * screen.
 *
 * The header's whole value is that a retry carries the **same** key: that is how the
 * server tells "the user asked twice" from "the network dropped the response and the
 * client asked again" (`src/api/idempotency.ts`). Minting inside the mutation makes every
 * attempt a fresh intent, and on this screen the cost of that is exact and expensive —
 * `approveBill` posts a journal against the payables control account, so a second key on a
 * double-clicked Approve is a second journal for one supplier invoice.
 *
 * ## Two shapes, because the routes fingerprint two different things
 *
 * `approveBill` and `approveVendorCredit` fingerprint `{ billId }` alone
 * (`transport/routes/bills.ts`), so the request is *the same request* however many times
 * it is attempted and however much the draft was edited between attempts. Its key
 * therefore belongs to the **document**, held against the id so that it survives the
 * editor unmounting and remounting between two clicks — which a `useRef` would not.
 * `discard` is the same shape: it fingerprints the id.
 *
 * A save and a void fingerprint their **body**, so reusing one key across two different
 * bodies is an `idempotency_key_conflict` — the key outliving its content, which
 * `presentApiError` correctly calls a bug in the screen. Those get a key bound to a
 * fingerprint of what is being sent: pressing Save twice on unchanged input is one intent
 * retried, changing a field and pressing it again is a new one.
 *
 * A failed attempt does not burn either kind: the claim rolls back with the operation
 * ("a failure is not poison", `modules/idempotency/service.ts`), which is what makes a
 * refused approval — a duplicate vendor reference, say — retryable with the key it already
 * had once the cause is dealt with.
 */
const keys = new Map<string, string>();

function keyOf(operation: string, resourceId: string): string {
  return `${operation}:${resourceId}`;
}

/** The key for an operation whose request is nothing but the resource id. */
export function documentIntentKey(operation: string, resourceId: string): string {
  const id = keyOf(operation, resourceId);
  const existing = keys.get(id);
  if (existing !== undefined) return existing;

  const minted = newIdempotencyKey();
  keys.set(id, minted);
  return minted;
}

/**
 * Dropped once the resource is gone, because nothing can be retried against it any more.
 * Not an optimization — a key kept against a discarded draft's id is a key that would be
 * reused if that id were ever reissued.
 */
export function releaseDocumentIntentKey(operation: string, resourceId: string): void {
  keys.delete(keyOf(operation, resourceId));
}

/** The key for an operation whose request carries a body: same body, same key. */
export function useFingerprintKey(): (fingerprint: string) => string {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);

  return useCallback((fingerprint: string): string => {
    const current = held.current;
    if (current !== null && current.fingerprint === fingerprint) return current.key;

    const key = newIdempotencyKey();
    held.current = { fingerprint, key };
    return key;
  }, []);
}
