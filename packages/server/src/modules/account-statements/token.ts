import { createHash, timingSafeEqual } from 'node:crypto';

import { selectStatementCredentialByKeyPrefix } from '../../db/statement-credential-lookup';
import { mintDeliveryToken } from '../delivery';
import type { MintedDeliveryToken } from '../delivery';

/**
 * The hosted customer-statement page's capability token (OB-220), sibling of
 * `delivery/token.ts`'s OB-121/D-74 one.
 *
 * ## Minting is reused verbatim; verifying is not
 *
 * `delivery/token.ts#mintDeliveryToken` mints `{prefix}.{secret}` and hashes it —
 * nothing about that construction names an invoice (`MintedDeliveryToken`'s three
 * fields are `token`/`keyPrefix`/`tokenHash`, generic to any bearer credential this
 * codebase mints), so it is re-exported here under this module's own name rather
 * than reimplemented. `verifyDeliveryToken`, by contrast, is hard-wired to
 * `invoice_deliveries` via `selectDeliveryCredentialByKeyPrefix`
 * (`db/delivery-lookup.ts`) and cannot be reused for a different table — this file
 * writes its own `verifyStatementToken`, reusing the identical crypto approach
 * (SHA-256 over the whole token string, `timingSafeEqual` for the comparison) for
 * `delivery/token.ts`'s own reasons, restated here rather than shared because the
 * two functions differ only in which lookup and which id field they resolve.
 */
export const mintStatementToken = mintDeliveryToken;
export type MintedStatementToken = MintedDeliveryToken;

/** What a verified statement token names: the org it belongs to and which statement it is. */
export interface StatementTokenMatch {
  readonly orgId: Buffer;
  readonly statementId: Buffer;
}

/**
 * Verifies a presented token against `customer_statements`, or returns `null`.
 *
 * `null` is the *only* outcome for every way a token can fail to match — an
 * unparseable value, an unknown prefix, a prefix that resolves but whose hash does
 * not match — for `delivery/token.ts#verifyDeliveryToken`'s exact A7 reason: the
 * caller (`public-statement.service.ts`) turns `null` into the same 404 a
 * genuinely nonexistent statement produces, so a forged token, a token for
 * someone else's statement, and a URL that was never issued must be
 * indistinguishable from each other.
 *
 * Both checks that can fail — "does this prefix name a row" and "does the hash
 * match" — are taken independently rather than one being allowed to short-circuit
 * observably: `selectStatementCredentialByKeyPrefix` returning `undefined` *does*
 * short-circuit (there is nothing left to hash against), but that branch and the
 * hash-mismatch branch below produce the identical `null`, and `timingSafeEqual`
 * is what keeps the hash comparison itself from leaking timing information one
 * byte at a time.
 */
export async function verifyStatementToken(token: string): Promise<StatementTokenMatch | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [keyPrefix, secret] = parts;
  if (keyPrefix === undefined || keyPrefix.length === 0) return null;
  if (secret === undefined || secret.length === 0) return null;

  const row = await selectStatementCredentialByKeyPrefix(keyPrefix);
  if (row === undefined) return null;

  const presented = hashToken(token);

  // `timingSafeEqual` throws on a length mismatch rather than returning `false`;
  // both sides are SHA-256 digests here (32 bytes each, always), so this is a
  // defensive guard against a stored value that is not — never a branch
  // production can reach — rather than a check this function expects to fail.
  if (presented.length !== row.tokenHash.length) return null;
  if (!timingSafeEqual(presented, row.tokenHash)) return null;

  return { orgId: row.orgId, statementId: row.id };
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}
