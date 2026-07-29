import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import type { SecretsProvider } from '@openbooks/plugin-api';

import type { SecretsConfig } from '../../config';
import { readSecret, upsertSecret } from '../../db';

/**
 * The self-host `SecretsProvider` (D-07, initiative J, D-101): a real,
 * encrypted-at-rest store rather than a stub, for `deterministic`'s reason in
 * `providers/extraction/deterministic.ts` — a self-host deployment with no AWS
 * account still needs somewhere to put a Stripe key, and so does the gate that
 * exercises `put`/`get` without a live secrets manager.
 *
 * ## The threat this defends against
 *
 * `secrets.ciphertext` is a row in the application's own database, readable by
 * anything that can read that table — a backup, a replica, a leaked dump. AES-
 * 256-GCM under an app key that lives only in `SECRETS_ENCRYPTION_KEY`
 * (config, never a domain table) means the row alone decrypts nothing; the key
 * has to come from the deployment's own configuration, exactly the separation
 * `session.secret` and `SESSION_SECRET` already keep for session tokens.
 *
 * ## The stored format
 *
 * `iv (12 bytes) || authTag (16 bytes) || ciphertext`, one `Buffer.concat`.
 * GCM's authentication tag is what turns a bit-flip in the stored blob (a
 * corrupted backup restore, a stray write) into a decrypt failure rather than
 * a silently wrong plaintext handed to a payment processor.
 */
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * SHA-256 of the configured app key, not the key itself: `SECRETS_ENCRYPTION_KEY`
 * is an operator-chosen string of unconstrained byte length beyond the 32-
 * character minimum `env.ts` enforces, and AES-256-GCM needs exactly 32 bytes.
 * Hashing is the same "derive a fixed-width key from an arbitrary secret"
 * move `verifyDeliveryToken`'s SHA-256 makes of a bearer token, applied here
 * to a passphrase instead of a credential.
 */
function deriveKey(encryptionKey: string): Buffer {
  return createHash('sha256').update(encryptionKey, 'utf8').digest();
}

export function createLocalSecretsProvider(
  secrets: Extract<SecretsConfig, { provider: 'local' }>,
): SecretsProvider {
  const key = deriveKey(secrets.encryptionKey);

  return {
    async put(name, value) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();

      await upsertSecret(name, Buffer.concat([iv, authTag, ciphertext]));
    },

    async get(name) {
      const blob = await readSecret(name);
      if (blob === undefined) {
        throw new Error(`No secret named "${name}" — it was never put, or the name is wrong.`);
      }

      const iv = blob.subarray(0, IV_BYTES);
      const authTag = blob.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
      const ciphertext = blob.subarray(IV_BYTES + AUTH_TAG_BYTES);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    },
  };
}
