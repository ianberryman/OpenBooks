import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { getConfig } from '../config';
import { InternalError } from '../errors';

/**
 * At-rest encryption for a **row-level sensitive column** — the default for per-row PII
 * (OB-228, D-228-2): a vendor TIN and anything like it lives encrypted in its own tenant
 * table column, never in the `secrets` store, which is only for an org's bounded credential
 * secrets (and has no `org_id`, so it sits outside the `tenantDb()` guard). This is the one
 * place the envelope is written, so `providers/secrets/local.ts` and every encrypted column
 * share it rather than each re-deriving AES-GCM.
 *
 * Format is `providers/secrets/local.ts`'s exactly — `iv(12) || authTag(16) || ciphertext`,
 * AES-256-GCM under a key derived `sha256(SECRETS_ENCRYPTION_KEY)`. The auth tag turns a
 * bit-flip in the stored blob into a decrypt failure rather than silently-wrong plaintext.
 *
 * The key is sourced from the `local` secrets config — `SECRETS_ENCRYPTION_KEY` is the app's
 * at-rest key regardless of where credential *secrets* are stored. Under `aws-secrets-manager`
 * (deferred, unbuilt) there is no such key, so this throws with a clear message; a dedicated
 * field-encryption key is the follow-up when hosted secrets ship (D-228-2a).
 */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

function fieldKey(): Buffer {
  const secrets = getConfig().providers.secrets;
  if (secrets.provider !== 'local') {
    throw new InternalError(
      'field-encryption needs SECRETS_ENCRYPTION_KEY (the local secrets provider); ' +
        'encrypted columns are not yet supported under aws-secrets-manager (D-228-2a).',
    );
  }
  return createHash('sha256').update(secrets.encryptionKey, 'utf8').digest();
}

export function encryptField(plaintext: string): Buffer {
  const key = fieldKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptField(blob: Buffer): string {
  const key = fieldKey();
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
