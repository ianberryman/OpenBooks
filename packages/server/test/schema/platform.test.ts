import { sql, type RawBuilder } from 'kysely';
import { describe, expect, it } from 'vitest';

import { newUuidBuffer, useTestDatabase } from '../db';

/**
 * The M5 platform schema (OB-096, ROADMAP D-53 through D-61).
 *
 * Two kinds of claim, matching `banking.test.ts`'s split:
 *
 *  - **Existence.** Each of the nine tables accepts a row shaped like the
 *    columns OB-096 specifies and returns it. The grant half — which of the
 *    nine the app user may UPDATE and which it may only append to — is already
 *    covered table-driven in `test/enforcement/grants.test.ts`; this is the
 *    schema half.
 *
 *  - **Impossibility.** The two directions of D-58's correlation-map
 *    uniqueness, D-61's opaque-token uniqueness, and D-56's per-org event
 *    numbering.
 *
 * Raw SQL throughout rather than Kysely's typed builder: this file is authored
 * before `generated.ts` is regenerated against the migrated schema (the
 * orchestrator's step, per `CLAUDE.md`), and `sql` tagged templates compile
 * against any live table regardless of what `DB` currently declares.
 */
const db = useTestDatabase();

/** mysql2 errno for a duplicate key — named so a bare number reads as intent. */
const DUPLICATE_KEY = 1062;

interface Scene {
  readonly orgId: Buffer;
  readonly userId: Buffer;
}

async function scene(): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  return { orgId: org.id, userId: user.id };
}

/** The errno a statement failed with, or `null` if it succeeded. */
async function errnoOf(statement: Promise<unknown>): Promise<number | null> {
  try {
    await statement;
    return null;
  } catch (error) {
    const errno = (error as { readonly errno?: unknown }).errno;
    if (typeof errno !== 'number') throw error;
    return errno;
  }
}

interface ClientOverrides {
  readonly id?: Buffer;
  readonly clientId?: string;
}

function insertClient(s: Scene, overrides: ClientOverrides = {}): RawBuilder<unknown> {
  return sql`
    INSERT INTO oauth_clients
      (id, org_id, client_id, name, secret_prefix, secret_hash, redirect_uris)
    VALUES (
      ${overrides.id ?? newUuidBuffer()}, ${s.orgId},
      ${overrides.clientId ?? `client-${newUuidBuffer().toString('hex')}`},
      'Test Integration', 'obcl_', ${'a'.repeat(64)},
      ${JSON.stringify(['https://example.com/callback'])}
    )
  `;
}

describe('the nine platform tables accept a row shaped like their columns (OB-096)', () => {
  it('creates an oauth client, an authorization code, a token, and a consent in FK order', async () => {
    const s = await scene();
    const clientId = newUuidBuffer();
    await insertClient(s, { id: clientId }).execute(db.app);

    const grantId = newUuidBuffer();
    await sql`
      INSERT INTO oauth_grants
        (id, org_id, client_id, user_id, code_hash, redirect_uri, scope,
         code_challenge, code_challenge_method, expires_at)
      VALUES (
        ${grantId}, ${s.orgId}, ${clientId}, ${s.userId}, ${'b'.repeat(64)},
        'https://example.com/callback', 'accounts.read', 'challenge-abc123', 'S256',
        ${'2026-08-01 00:00:00.000'}
      )
    `.execute(db.app);

    const tokenId = newUuidBuffer();
    await sql`
      INSERT INTO oauth_tokens
        (id, org_id, client_id, user_id, token_type, key_prefix, token_hash, scope, expires_at)
      VALUES (
        ${tokenId}, ${s.orgId}, ${clientId}, ${s.userId}, 'access', 'obat_',
        ${'d'.repeat(64)}, 'accounts.read', ${'2026-08-01 00:00:00.000'}
      )
    `.execute(db.app);

    const consentId = newUuidBuffer();
    await sql`
      INSERT INTO oauth_consents (id, org_id, client_id, user_id, scope)
      VALUES (${consentId}, ${s.orgId}, ${clientId}, ${s.userId}, 'accounts.read')
    `.execute(db.app);

    const { rows: clients } = await sql<{ client_id: string }>`
      SELECT client_id FROM oauth_clients WHERE id = ${clientId}
    `.execute(db.app);
    expect(clients).toHaveLength(1);

    const { rows: grants } = await sql<{ consumed_at: Date | null }>`
      SELECT consumed_at FROM oauth_grants WHERE id = ${grantId}
    `.execute(db.app);
    expect(grants).toEqual([{ consumed_at: null }]);

    const { rows: tokens } = await sql<{ token_type: string; revoked_at: Date | null }>`
      SELECT token_type, revoked_at FROM oauth_tokens WHERE id = ${tokenId}
    `.execute(db.app);
    expect(tokens).toEqual([{ token_type: 'access', revoked_at: null }]);

    const { rows: consents } = await sql<{ scope: string }>`
      SELECT scope FROM oauth_consents WHERE id = ${consentId}
    `.execute(db.app);
    expect(consents).toEqual([{ scope: 'accounts.read' }]);
  });

  it('creates an external ref, an event-log row numbered from its counter, and a change-feed cursor', async () => {
    const s = await scene();

    const refId = newUuidBuffer();
    const entityId = newUuidBuffer();
    await sql`
      INSERT INTO external_refs (id, org_id, external_system, entity_type, external_id, entity_id)
      VALUES (${refId}, ${s.orgId}, 'quickbooks', 'contact', 'QB-1001', ${entityId})
    `.execute(db.app);

    // The counter `event_log.position` is allocated from (D-56, the D-14
    // pattern), maintained by the migrator here since only OB-100's relay
    // claims it FOR UPDATE in production.
    await sql`
      INSERT INTO event_positions (org_id, next_value) VALUES (${s.orgId}, 2)
    `.execute(db.migrator);

    const eventId = newUuidBuffer();
    await sql`
      INSERT INTO event_log (id, org_id, position, name, actor_type, actor_id, payload)
      VALUES (
        ${eventId}, ${s.orgId}, 1, 'invoice.approved.v1', 'user', ${s.userId.toString('hex')},
        ${JSON.stringify({ invoiceId: 'inv-1' })}
      )
    `.execute(db.app);

    const cursorId = newUuidBuffer();
    await sql`
      INSERT INTO change_feed_cursors (id, org_id, subscriber, position)
      VALUES (${cursorId}, ${s.orgId}, 'test-subscriber', 0)
    `.execute(db.app);

    const { rows: refs } = await sql<{ entity_id: Buffer }>`
      SELECT entity_id FROM external_refs WHERE id = ${refId}
    `.execute(db.app);
    expect(refs[0]?.entity_id.equals(entityId)).toBe(true);

    const { rows: events } = await sql<{ name: string; position: bigint }>`
      SELECT name, position FROM event_log WHERE id = ${eventId}
    `.execute(db.app);
    expect(events).toEqual([{ name: 'invoice.approved.v1', position: 1n }]);

    const { rows: cursors } = await sql<{ subscriber: string; position: bigint }>`
      SELECT subscriber, position FROM change_feed_cursors WHERE id = ${cursorId}
    `.execute(db.app);
    expect(cursors).toEqual([{ subscriber: 'test-subscriber', position: 0n }]);
  });

  it('creates a security event with no foreign key to hold it back on the credential it names', async () => {
    const s = await scene();
    const eventId = newUuidBuffer();
    const credentialId = newUuidBuffer();

    // credential_id is polymorphic across api_keys/oauth_tokens/oauth_clients
    // (see the header of 0010_platform), so it deliberately names no row that
    // has to exist — an id that belongs to nothing here is accepted.
    await sql`
      INSERT INTO security_events
        (id, org_id, event_type, actor_user_id, credential_type, credential_id, detail)
      VALUES (
        ${eventId}, ${s.orgId}, 'oauth_token.issued', ${s.userId}, 'oauth_token', ${credentialId},
        ${JSON.stringify({ scope: 'accounts.read' })}
      )
    `.execute(db.app);

    const { rows } = await sql<{ event_type: string; actor_user_id: Buffer | null }>`
      SELECT event_type, actor_user_id FROM security_events WHERE id = ${eventId}
    `.execute(db.app);
    expect(rows).toEqual([{ event_type: 'oauth_token.issued', actor_user_id: s.userId }]);
  });
});

describe('external_refs is a correlation map, unique both ways (D-58)', () => {
  it('refuses a second external id for the same external identity', async () => {
    const s = await scene();
    await sql`
      INSERT INTO external_refs (id, org_id, external_system, entity_type, external_id, entity_id)
      VALUES (${newUuidBuffer()}, ${s.orgId}, 'quickbooks', 'contact', 'QB-1001', ${newUuidBuffer()})
    `.execute(db.app);

    expect(
      await errnoOf(
        sql`
          INSERT INTO external_refs
            (id, org_id, external_system, entity_type, external_id, entity_id)
          VALUES (${newUuidBuffer()}, ${s.orgId}, 'quickbooks', 'contact', 'QB-1001', ${newUuidBuffer()})
        `.execute(db.app),
      ),
    ).toBe(DUPLICATE_KEY);
  });

  it('refuses a second external identity mapped to the same entity', async () => {
    const s = await scene();
    const entityId = newUuidBuffer();
    await sql`
      INSERT INTO external_refs (id, org_id, external_system, entity_type, external_id, entity_id)
      VALUES (${newUuidBuffer()}, ${s.orgId}, 'quickbooks', 'contact', 'QB-1001', ${entityId})
    `.execute(db.app);

    expect(
      await errnoOf(
        sql`
          INSERT INTO external_refs
            (id, org_id, external_system, entity_type, external_id, entity_id)
          VALUES (${newUuidBuffer()}, ${s.orgId}, 'quickbooks', 'contact', 'QB-1002', ${entityId})
        `.execute(db.app),
      ),
    ).toBe(DUPLICATE_KEY);
  });

  it('admits the same external id in a different system, so systems do not collide', async () => {
    const s = await scene();
    await sql`
      INSERT INTO external_refs (id, org_id, external_system, entity_type, external_id, entity_id)
      VALUES (${newUuidBuffer()}, ${s.orgId}, 'quickbooks', 'contact', 'DUP-1', ${newUuidBuffer()})
    `.execute(db.app);

    expect(
      await errnoOf(
        sql`
          INSERT INTO external_refs
            (id, org_id, external_system, entity_type, external_id, entity_id)
          VALUES (${newUuidBuffer()}, ${s.orgId}, 'xero', 'contact', 'DUP-1', ${newUuidBuffer()})
        `.execute(db.app),
      ),
    ).toBeNull();
  });
});

describe('oauth_tokens are opaque and unique on their hash (D-61)', () => {
  it('refuses a second token with the same hash', async () => {
    const s = await scene();
    const clientId = newUuidBuffer();
    await insertClient(s, { id: clientId }).execute(db.app);
    const hash = 'e'.repeat(64);

    await sql`
      INSERT INTO oauth_tokens
        (id, org_id, client_id, user_id, token_type, key_prefix, token_hash, scope, expires_at)
      VALUES (
        ${newUuidBuffer()}, ${s.orgId}, ${clientId}, ${s.userId}, 'access', 'obat_', ${hash},
        'accounts.read', ${'2026-08-01 00:00:00.000'}
      )
    `.execute(db.app);

    // A second row of a different type reusing the same hash — the uniqueness
    // is on the hash alone, not on (hash, token_type), because a collision on an
    // opaque secret must be impossible regardless of what kind of credential it
    // is minted for.
    expect(
      await errnoOf(
        sql`
          INSERT INTO oauth_tokens
            (id, org_id, client_id, user_id, token_type, key_prefix, token_hash, scope, expires_at)
          VALUES (
            ${newUuidBuffer()}, ${s.orgId}, ${clientId}, ${s.userId}, 'refresh', 'obrt_', ${hash},
            'accounts.read', ${'2026-08-01 00:00:00.000'}
          )
        `.execute(db.app),
      ),
    ).toBe(DUPLICATE_KEY);
  });
});

describe('event_log is numbered once per org, never twice (D-56)', () => {
  it('refuses a second row at the same (org_id, position)', async () => {
    const s = await scene();
    await sql`
      INSERT INTO event_log (id, org_id, position, name, actor_type, actor_id, payload)
      VALUES (
        ${newUuidBuffer()}, ${s.orgId}, 1, 'invoice.approved.v1', 'user',
        ${s.userId.toString('hex')}, ${JSON.stringify({})}
      )
    `.execute(db.app);

    expect(
      await errnoOf(
        sql`
          INSERT INTO event_log (id, org_id, position, name, actor_type, actor_id, payload)
          VALUES (
            ${newUuidBuffer()}, ${s.orgId}, 1, 'bill.approved.v1', 'user',
            ${s.userId.toString('hex')}, ${JSON.stringify({})}
          )
        `.execute(db.app),
      ),
    ).toBe(DUPLICATE_KEY);
  });

  it('admits the same position in a different org, because ordering is per-org (D-56)', async () => {
    const a = await scene();
    const b = await scene();
    await sql`
      INSERT INTO event_log (id, org_id, position, name, actor_type, actor_id, payload)
      VALUES (
        ${newUuidBuffer()}, ${a.orgId}, 1, 'invoice.approved.v1', 'user',
        ${a.userId.toString('hex')}, ${JSON.stringify({})}
      )
    `.execute(db.app);

    expect(
      await errnoOf(
        sql`
          INSERT INTO event_log (id, org_id, position, name, actor_type, actor_id, payload)
          VALUES (
            ${newUuidBuffer()}, ${b.orgId}, 1, 'invoice.approved.v1', 'user',
            ${b.userId.toString('hex')}, ${JSON.stringify({})}
          )
        `.execute(db.app),
      ),
    ).toBeNull();
  });
});
