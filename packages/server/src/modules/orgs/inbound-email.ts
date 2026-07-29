import { randomBytes } from 'node:crypto';

import { getContext } from '../../context';
import type { RequestContext } from '../../context';
import { bufferToUuid, systemDb, uuidToBuffer } from '../../db';
import { InternalError } from '../../errors';
import { requirePermission } from '../permissions';

import { isDuplicateEntryError } from './orgs.repository';

/**
 * The org's inbound-email capture address (initiative O, OB-186; ROADMAP
 * "Real MX/receipt-rule receiving is out of scope this wave" — the pinned
 * contract's own words).
 *
 * `orgs.inbound_email_token` (migration `0001_tenancy`'s in-place edit) is a
 * `BINARY(16) NULL UNIQUE` column, minted lazily on first read rather than
 * backfilled — the same shape `org_branding`'s lazily-created row takes
 * (`branding.service.ts`), one level simpler: there is no second table here,
 * only a column an org may not have touched yet.
 *
 * ## Why `systemDb`, not `tenantDb`
 *
 * `orgs` carries no `org_id` of its own to scope on — it *is* the org
 * (`selectOrg`'s comment in `orgs.repository.ts` makes the identical point about
 * `orgs.name`). Every read and write here goes through the system handle and
 * addresses the row by its own primary key.
 *
 * ## The token, and why it is not hashed
 *
 * 16 random bytes, base64url-encoded for the two places it travels: the mailbox
 * local-part this module hands back, and the `:token` segment
 * `POST /v1/bills/inbound/:token` resolves. Stored raw rather than as a digest,
 * unlike `sessionTokenHash`/`token.ts`'s delivery credential: those authenticate
 * a *session* or a *document view*, where a leaked value grants a real
 * capability, so the row is hashed against exactly that leak. This token's
 * whole job is routing an inbound webhook to the right org — the webhook
 * provider (`dev`, `ses-inbound`) is the actual trust boundary, and a forged
 * token here at worst files a capture into the wrong org's staging area, not a
 * financial document (D-25: capture never auto-posts). 128 bits is still enough
 * that it is not guessable by trying.
 */

/** `orgs.inbound_email_token` is `BINARY(16)`. */
const TOKEN_BYTES = 16;

/** How many random collisions with *another* org's token are tolerated before giving up. */
const MAX_MINT_ATTEMPTS = 5;

/**
 * The placeholder domain a minted address is built under.
 *
 * Real MX / SES receipt-rule wiring is explicitly out of scope this wave (the
 * pinned contract's locked decisions); this is what a UI has to show *something*
 * against until an operator wires real inbound receiving to the `dev`/`ses-inbound`
 * adapter's webhook. Not read from config, because no such config exists yet —
 * see the extraction-provider config plumbing (`config/providers.ts`) for the
 * shape a future `INBOUND_MAIL_DOMAIN` setting would take.
 */
const INBOUND_MAIL_PLACEHOLDER_DOMAIN = 'inbound.openbooks.app';

export interface InboundEmailAddress {
  readonly address: string;
}

function encodeToken(token: Buffer): string {
  return token.toString('base64url');
}

function decodeToken(token: string): Buffer | undefined {
  if (token.length === 0) return undefined;
  const decoded = Buffer.from(token, 'base64url');
  // A malformed or truncated token decodes to the wrong length; treated as "no
  // such token" rather than a 400, `A7`'s reasoning applied to a capability
  // token exactly as `verifyDeliveryToken` applies it to the delivery credential.
  return decoded.length === TOKEN_BYTES ? decoded : undefined;
}

/** Mints and stores a token for `orgId` if it has none, and returns the token bytes either way. */
async function ensureInboundEmailToken(orgId: Buffer): Promise<Buffer> {
  const existing = await systemDb()
    .selectFrom('orgs')
    .select('inbound_email_token')
    .where('id', '=', orgId)
    .executeTakeFirst();

  if (existing === undefined) {
    // `orgId` originates from a resolved session's `ctx.orgId`, the same
    // guarantee `requireOrgIdentity` in `branding.service.ts` relies on: a miss
    // here is a wiring fault, not client input.
    throw new InternalError(
      `Context named an org (${bufferToUuid(orgId)}) with no row in \`orgs\`. This context's ` +
        'orgId originates from a resolved session, so a miss here is a server-side wiring fault.',
    );
  }
  if (existing.inbound_email_token !== null) return existing.inbound_email_token;

  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt += 1) {
    const token = randomBytes(TOKEN_BYTES);
    try {
      const result = await systemDb()
        .updateTable('orgs')
        .set({ inbound_email_token: token })
        .where('id', '=', orgId)
        .where('inbound_email_token', 'is', null)
        .executeTakeFirst();

      if (Number(result.numUpdatedRows) === 1) return token;

      // Zero rows updated with no thrown error means a concurrent mint won the
      // race between the read above and this write — re-read rather than retry
      // with a fresh token, so the two concurrent callers agree on one value.
      const won = await systemDb()
        .selectFrom('orgs')
        .select('inbound_email_token')
        .where('id', '=', orgId)
        .executeTakeFirstOrThrow();
      if (won.inbound_email_token !== null) return won.inbound_email_token;
    } catch (error) {
      // The unique index on `inbound_email_token` refused a genuine collision
      // with another org's token — 128 bits of entropy, so this is a coincidence
      // worth one retry and not a sign anything is wrong.
      if (isDuplicateEntryError(error)) continue;
      throw error;
    }
  }

  throw new InternalError(
    `Could not mint a unique inbound_email_token for org ${bufferToUuid(orgId)} in ` +
      `${String(MAX_MINT_ATTEMPTS)} attempts. Each attempt draws 128 bits of entropy, so this is a ` +
      'fault rather than contention.',
  );
}

/**
 * The org's inbound-capture mailbox, minting one if this is the first time
 * anyone has asked.
 *
 * `bills.write` rather than `bills.read`: unlike `getBranding`, the first call
 * genuinely writes a row (the lazily-minted token), which is the write-shaped
 * half of `bills.write`'s surface (capture upload, inbound, create-draft) rather
 * than the read-shaped half (list/read captures) the pinned contract splits the
 * catalog on.
 */
export async function getInboundEmailAddress(
  ctx: RequestContext = getContext('getInboundEmailAddress()'),
): Promise<InboundEmailAddress> {
  await requirePermission(ctx, 'bills.write');

  const token = await ensureInboundEmailToken(uuidToBuffer(ctx.orgId));
  return { address: `bills+${encodeToken(token)}@${INBOUND_MAIL_PLACEHOLDER_DOMAIN}` };
}

/**
 * Resolves an inbound webhook's `:token` path segment to the org it names, or
 * `null` for every way it can fail to name one — malformed, unissued, or (not
 * reachable today, since nothing deletes an org's token) revoked. The route
 * turns `null` into the same `404` A7 uses everywhere else, `verifyDeliveryToken`'s
 * shape applied to this token.
 */
export async function resolveOrgIdForInboundToken(token: string): Promise<string | null> {
  const bytes = decodeToken(token);
  if (bytes === undefined) return null;

  const row = await systemDb()
    .selectFrom('orgs')
    .select('id')
    .where('inbound_email_token', '=', bytes)
    .executeTakeFirst();

  return row === undefined ? null : bufferToUuid(row.id);
}
