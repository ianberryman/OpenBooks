import { useCallback, useRef } from 'react';

import { newIdempotencyKey } from '../../api';

/**
 * One `Idempotency-Key` per user intent, and a new one exactly when the intent changes.
 *
 * The header's whole value is that a *retry* carries the **same** key: that is how the
 * server distinguishes "the user asked twice" from "the network dropped the response"
 * (`src/api/idempotency.ts`). Two obvious implementations both break it. Minting inside
 * the mutation makes every attempt a fresh intent, so a re-submitted form is a second
 * account. Minting once when a dialog opens makes a corrected form reuse the key of the
 * request it replaces, which the server answers with `idempotency_key_conflict` — the key
 * outliving its content, which `presentApiError` correctly calls a bug in the screen.
 *
 * So the key is bound to what is being sent. The caller passes a fingerprint of the
 * payload; an identical fingerprint returns the key it returned before, and a different
 * one mints. Pressing "Save" twice on unchanged input is one intent retried; changing a
 * field and pressing it again is a new one.
 */
export function useIntentKey(): (fingerprint: string) => string {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);

  return useCallback((fingerprint: string): string => {
    const current = held.current;
    if (current !== null && current.fingerprint === fingerprint) return current.key;

    const key = newIdempotencyKey();
    held.current = { fingerprint, key };
    return key;
  }, []);
}
