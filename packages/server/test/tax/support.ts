import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, type RequestContext } from '../../src/context';
import {
  destroyDatabase,
  initializeDatabase,
  isDatabaseInitialized,
  newUuidBuffer,
  uuidToBuffer,
} from '../../src/db';
import type { SystemRoleName, TestDatabase } from '../db';
import { SYSTEM_ROLE_UUIDS, systemRoleId, useTestDatabase } from '../db';

/**
 * Support for the OB-066 suite.
 *
 * These drive the real service, so the *process* database handle has to be
 * initialized as well as the harness's own pools: the tax repository reaches data
 * through `tenantDb()`, which reads the module-private client in
 * `src/db/client.ts`. Pointing that client at the harness container is what makes
 * these tests statements about the production path rather than about a second
 * query written for the test.
 *
 * The app user, not the migrator — the identity the application runs as (spec
 * §12). `tax_rates` joined `0999_app_grants`'s `MUTABLE_TABLES` with OB-060, which
 * is what lets the update, archive and delete paths run as the application at all;
 * a missing privilege is a finding and it surfaces here rather than in production.
 *
 * `useServiceDatabase`, `contextFor` and `actorIn` are the fourth copy of
 * `test/accounts/support.ts`. Copied rather than imported, following the
 * convention those files state: they are other tickets' fixtures, and neither
 * suite should break when the other's helper changes.
 */
export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  // Registered after the harness's own `beforeAll`, so `appConnectionConfig` is
  // live by the time this runs.
  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

/**
 * A request context for an `(org, role, user)` triple.
 *
 * Through `createRequestContext` rather than an object literal, because the
 * permission memo is keyed on that frozen object's identity.
 */
export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

/**
 * An org, a member user holding one of the six seeded system roles, and a context.
 *
 * Real seeded roles rather than a custom bundle, because the point of the
 * enforcement assertions is what a *shipped* role can do: `read_only` and
 * `ar_only` both hold `tax_rates.read` and neither holds `tax_rates.write`
 * (migration `0001_tenancy`), which is exactly the pair those tests need.
 */
export async function actorIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<ActorFixture> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
  };
}

/**
 * A document line citing a tax rate, written as the application identity.
 *
 * This is the fixture the delete rule has to be proven against. A test that
 * asserted the refusal by stubbing the pre-check would pass against a service with
 * no `RESTRICT` behind it, and the `RESTRICT` is the guarantee — so the reference
 * here is a real `ar_document_lines` (or `ap_document_lines`) row, inserted
 * through `db.app`, which is the identity that will hold it in production.
 *
 * Minimal but valid: `chk_ar_documents_approved` pairs `journal_id` with
 * `sequence_number` and this leaves both NULL, which is a *draft* document. That
 * is on purpose — `fk_ar_document_lines_tax_rate` does not distinguish a draft
 * line from an approved one, so a delete rule that only looked at approved
 * documents would promise a delete the database then refused with errno 1451.
 *
 * The columns are written directly rather than through OB-062's service because
 * that service does not exist yet and this suite must not wait on it; when it
 * does, this helper is the thing to replace.
 */
export async function citeTaxRate(
  db: TestDatabase,
  side: 'ar' | 'ap',
  actor: ActorFixture,
  taxRateId: string,
  accountId: Buffer,
): Promise<void> {
  const contactId = newUuidBuffer();
  const documentId = newUuidBuffer();

  await db.app
    .insertInto('contacts')
    .values({
      id: contactId,
      org_id: actor.orgId,
      display_name: 'Fixture Contact',
      is_customer: 1,
      is_vendor: 1,
    })
    .execute();

  if (side === 'ar') {
    await db.app
      .insertInto('ar_documents')
      .values({
        id: documentId,
        org_id: actor.orgId,
        document_type: 'invoice',
        contact_id: contactId,
        issue_date: '2026-01-31',
        tax_mode: 'exclusive',
        created_by_user_id: actor.userId,
      })
      .execute();

    await db.app
      .insertInto('ar_document_lines')
      .values({
        org_id: actor.orgId,
        document_id: documentId,
        line_number: 1,
        quantity_micros: 1_000_000n,
        unit_amount_minor: 100_00n,
        account_id: accountId,
        tax_rate_id: uuidToBuffer(taxRateId),
        line_amount_minor: 100_00n,
        tax_amount_minor: 20_00n,
      })
      .execute();
    return;
  }

  await db.app
    .insertInto('ap_documents')
    .values({
      id: documentId,
      org_id: actor.orgId,
      document_type: 'bill',
      contact_id: contactId,
      issue_date: '2026-01-31',
      tax_mode: 'exclusive',
      created_by_user_id: actor.userId,
    })
    .execute();

  await db.app
    .insertInto('ap_document_lines')
    .values({
      org_id: actor.orgId,
      document_id: documentId,
      line_number: 1,
      quantity_micros: 1_000_000n,
      unit_amount_minor: 100_00n,
      account_id: accountId,
      tax_rate_id: uuidToBuffer(taxRateId),
      line_amount_minor: 100_00n,
      tax_amount_minor: 20_00n,
    })
    .execute();
}
