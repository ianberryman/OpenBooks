import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, type RequestContext } from '../../context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized, systemDb } from '../../db';
import { PermissionDeniedError, UnauthenticatedError } from '../../errors';
import { setStorageProvider, storageProvider } from '../../providers';
import { createLocalStorageProvider } from '../../providers/storage/local';
import type { PermissionKey } from '../permissions';

import type { SystemRoleName, TestDatabase } from '../../../test/db';
import {
  newUuid,
  SYSTEM_ROLE_UUIDS,
  systemRoleId,
  uuidToBuffer,
  useTestDatabase,
} from '../../../test/db';

import { createStatementPackage, listStatementPackages } from './statement-package.service';

/**
 * `createStatementPackage`/`listStatementPackages` (initiative P, OB-195; ROADMAP
 * P5), against real MySQL — never a mock (spec §11), so the artifact really lands
 * in the `local` `StorageProvider` and the row really lands in
 * `statement_packages`.
 *
 * The org fixtures below carry no ledger activity, which is deliberate rather
 * than a shortcut: every figure the three report services return is `"0"`, and
 * that is exactly the "dense report" shape `getAccountBalances` already commits
 * to for an account with no postings — proving the plumbing (permission, render,
 * store, record, sign) does not need a populated chart, and the reports' own
 * arithmetic is proven where it lives, in `test/reports/`.
 *
 * The rendered bytes are asserted non-empty and PDF-shaped (`%PDF` magic) rather
 * than parsed — pdfmake's declarative layout is `document.ts`'s to get right, and
 * the property this suite owns is that the service wires it to storage and to the
 * row, not that the layout is correct.
 */

function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

/** A `local` storage provider over a fresh temp directory, installed for this file's duration. */
function useLocalStorage(): void {
  let basePath: string | undefined;

  beforeAll(async () => {
    basePath = await mkdtemp(join(tmpdir(), 'openbooks-statements-'));
    setStorageProvider(createLocalStorageProvider({ provider: 'local', basePath }));
  });

  afterAll(async () => {
    setStorageProvider(undefined);
    if (basePath !== undefined) await rm(basePath, { recursive: true, force: true });
  });
}

const db = useServiceDatabase();
useLocalStorage();

interface ActorFixture {
  readonly orgUuid: string;
  readonly userUuid: string;
  readonly userDisplayName: string;
  readonly ctx: RequestContext;
}

/** An org, a member holding one of the seeded roles, and a context for the pair. */
async function actorIn(role: SystemRoleName = 'accountant'): Promise<ActorFixture> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });

  return {
    orgUuid: org.uuid,
    userUuid: user.uuid,
    userDisplayName: user.displayName,
    ctx: createRequestContext({
      orgId: org.uuid,
      roleId: SYSTEM_ROLE_UUIDS[role],
      userId: user.uuid,
      actorType: 'user',
      actorId: user.uuid,
    }),
  };
}

/** A custom role holding exactly the given permissions, for testing the `reports.read` gate. */
async function customRole(orgUuid: string, permissions: readonly PermissionKey[]): Promise<string> {
  const roleUuid = newUuid();
  const roleId = uuidToBuffer(roleUuid);

  await systemDb()
    .insertInto('roles')
    .values({
      id: roleId,
      org_id: uuidToBuffer(orgUuid),
      code: `statements-role-${roleUuid.slice(0, 8)}`,
      name: 'Test role',
      description: 'Created by the OB-195 suite.',
      is_system: 0,
    })
    .execute();

  if (permissions.length > 0) {
    await systemDb()
      .insertInto('role_permissions')
      .values(permissions.map((code) => ({ role_id: roleId, permission_code: code })))
      .execute();
  }

  return roleUuid;
}

const PERIOD_START = '2026-01-01';
const PERIOD_END = '2026-03-31';

describe('createStatementPackage', () => {
  it('renders a PDF, stores it, records the row, and returns a signed download URL', async () => {
    const actor = await actorIn();

    const created = await createStatementPackage(
      { periodStart: PERIOD_START, periodEnd: PERIOD_END },
      actor.ctx,
    );

    expect(created).toMatchObject({
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      basis: 'accrual',
      generatedByUserId: actor.userUuid,
      generatedByName: actor.userDisplayName,
    });
    expect(created.downloadUrl.length).toBeGreaterThan(0);
    expect(() => new URL(created.downloadUrl, 'https://example.test')).not.toThrow();

    const row = await db.app
      .selectFrom('statement_packages')
      .selectAll()
      .where('id', '=', uuidToBuffer(created.id))
      .executeTakeFirst();
    if (row === undefined) throw new Error('expected a persisted statement_packages row');

    expect(row.period_start).toBe(PERIOD_START);
    expect(row.period_end).toBe(PERIOD_END);
    expect(row.basis).toBe('accrual');
    expect(row.artifact_storage_key).toMatch(
      new RegExp(`^org/${actor.orgUuid}/statements/[0-9a-f-]{36}\\.pdf$`),
    );
    expect(row.generated_by_user_id).toEqual(uuidToBuffer(actor.userUuid));

    const bytes = await storageProvider().get(row.artifact_storage_key);
    expect(bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('%PDF');
  });

  it('honours an explicit cash basis over the org default', async () => {
    const actor = await actorIn();

    const created = await createStatementPackage(
      { periodStart: PERIOD_START, periodEnd: PERIOD_END, basis: 'cash' },
      actor.ctx,
    );

    expect(created.basis).toBe('cash');

    const row = await db.app
      .selectFrom('statement_packages')
      .select('basis')
      .where('id', '=', uuidToBuffer(created.id))
      .executeTakeFirstOrThrow();
    expect(row.basis).toBe('cash');
  });

  it('requires reports.read', async () => {
    const actor = await actorIn();
    const roleUuid = await customRole(actor.orgUuid, ['invoices.read']);
    const ctx = createRequestContext({
      orgId: actor.orgUuid,
      roleId: roleUuid,
      userId: actor.userUuid,
      actorType: 'user',
      actorId: actor.userUuid,
    });

    await expect(
      createStatementPackage({ periodStart: PERIOD_START, periodEnd: PERIOD_END }, ctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);

    const rows = await db.app
      .selectFrom('statement_packages')
      .selectAll()
      .where('org_id', '=', uuidToBuffer(actor.orgUuid))
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('refuses a caller with no user behind the request', async () => {
    const actor = await actorIn();
    const automationCtx = createRequestContext({
      orgId: actor.orgUuid,
      roleId: SYSTEM_ROLE_UUIDS.accountant,
      userId: null,
      actorType: 'automation',
      actorId: 'statement-package-suite',
    });

    await expect(
      createStatementPackage({ periodStart: PERIOD_START, periodEnd: PERIOD_END }, automationCtx),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('listStatementPackages', () => {
  it('returns every package for the org, newest first, each with a fresh downloadUrl', async () => {
    const actor = await actorIn();

    await createStatementPackage({ periodStart: '2026-01-01', periodEnd: '2026-01-31' }, actor.ctx);
    await createStatementPackage({ periodStart: '2026-02-01', periodEnd: '2026-02-28' }, actor.ctx);

    // The order this asserts is the repository's own definition of "newest
    // first" — `ORDER BY created_at DESC, id DESC` — rather than an assumption
    // about which of the two calls above landed in an earlier millisecond, which
    // `DATETIME(3)`'s precision does not rule out two of them sharing.
    const rows = await db.app
      .selectFrom('statement_packages')
      .selectAll()
      .where('org_id', '=', uuidToBuffer(actor.orgUuid))
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();

    const list = await listStatementPackages(actor.ctx);

    expect(list.packages.map((entry) => uuidToBuffer(entry.id))).toEqual(rows.map((row) => row.id));

    for (const entry of list.packages) {
      expect(entry.downloadUrl.length).toBeGreaterThan(0);
      expect(entry.generatedByName).toBe(actor.userDisplayName);
    }
  });

  it("does not return another org's packages", async () => {
    const actor = await actorIn();
    const other = await actorIn();

    await createStatementPackage({ periodStart: PERIOD_START, periodEnd: PERIOD_END }, other.ctx);

    const list = await listStatementPackages(actor.ctx);
    expect(list.packages).toHaveLength(0);
  });

  it('requires reports.read', async () => {
    const actor = await actorIn();
    const roleUuid = await customRole(actor.orgUuid, ['invoices.read']);
    const ctx = createRequestContext({
      orgId: actor.orgUuid,
      roleId: roleUuid,
      userId: actor.userUuid,
      actorType: 'user',
      actorId: actor.userUuid,
    });

    await expect(listStatementPackages(ctx)).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
