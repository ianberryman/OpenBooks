import { createHash, randomBytes } from 'node:crypto';

/**
 * Invite tokens: issued once, stored as a SHA-256 digest (spec §5, ROADMAP D-03).
 *
 * ## Why this is `auth/tokens.ts` again rather than an import of it
 *
 * The two are the same construction — 256 bits from `randomBytes`, base64url on the
 * wire, lowercase hex in a `CHAR(64)` column — and the reasoning D-03 records for
 * sessions transfers unchanged: migration `0001_tenancy` states the requirement for
 * "session, invite, and API-key material alike", namely that a database read must
 * not yield a usable credential. A fast hash is right here for the same reason it is
 * right there: the secret is uniform CSPRNG output, so there is no guessing attack
 * for a KDF to slow down, and a salted digest could not be found by unique index
 * (`uq_org_invites_token`) at all.
 *
 * What differs is the *lifecycle*, which is why these are two files and not one
 * shared helper. A session token is minted at login and revoked at logout; an invite
 * token is minted for a third party who does not yet have an account, is single-use,
 * and dies on acceptance. Folding both into one module would create a place where a
 * change made for one credential silently applies to the other — and the change
 * likeliest to be made, adding a rotation or a re-issue path, is exactly the one
 * that must not.
 */

/**
 * 32 bytes, matching SHA-256's own width so the digest is not the weaker half of
 * the pair. Base64url, so the token drops into the query string of an invite link
 * without escaping.
 */
const INVITE_TOKEN_BYTES = 32;

/**
 * How long an invite is good for: **7 days**.
 *
 * Shorter than the 14-day session (`auth/cookie.ts`), and the asymmetry is the
 * point. A session is a credential in active use by a person who holds it; an
 * invite is a credential sitting *unused by definition* in a mailbox, which is
 * exactly the state in which a leaked one is not noticed. A week covers "sent on a
 * Friday, read the following Thursday", which is the realistic delay for the target
 * business, and the recovery when it does lapse is one call by the inviter rather
 * than a support path.
 *
 * The expiry is written into the row at issue rather than computed on read, so
 * changing this constant does not retroactively extend or kill invites already in
 * flight.
 */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function newInviteToken(): string {
  return randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
}

/** Lowercase hex, 64 characters, which is what `org_invites.token_hash` holds. */
export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
