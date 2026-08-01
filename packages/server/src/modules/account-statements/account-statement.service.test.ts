import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRequestContext, type RequestContext } from '../../context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../db';
import { NotFoundError, PermissionDeniedError, UnauthenticatedError } from '../../errors';
import { setStorageProvider, storageProvider } from '../../providers';
import { createLocalStorageProvider } from '../../providers/storage/local';
import type { PermissionKey } from '../permissions';

import type { TestDatabase } from '../../../test/db';
import {
  newUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  uuidToBuffer,
  useTestDatabase,
} from '../../../test/db';
import { captureEmail, TEST_APP_BASE_URL } from '../../../test/members/support';
import {
  contextFor,
  createChart,
  createParty,
  createScene,
  post,
  type Scene,
} from '../../../test/reports/support';

import { getPublicStatementArtifact } from './public-statement.service';
import { createCustomerStatement, listCustomerStatements } from './account-statement.service';

/**
 * `createCustomerStatement`/`listCustomerStatements` (OB-220 part 1), against real
 * MySQL — never a mock (spec §11), so the artifact really lands in the `local`
 * `StorageProvider`, the row really lands in `customer_statements`, and — when
 * delivery is requested — the email really goes through the real `log` adapter
 * (`test/members/support.ts#captureEmail`), so a test that asserts a hosted link
 * works reads that link out of the message the system actually produced and
 * fetches it back through `getPublicStatementArtifact`, the same function the
 * unauthenticated route calls.
 *
 * `createScene`/`createChart`/`post`/`createParty` (`test/reports/support.ts`) are
 * OB-041's fixtures, reused rather than duplicated: a customer statement is
 * `getAging` for one contact (`aging.service.ts`'s file header), so the arithmetic
 * this suite needs to trust is exactly the one `test/reports/aging.test.ts` already
 * proves by hand — this suite only has to prove the plumbing around it (permission,
 * render, store, record, and — new here — deliver) matches an aging report a
 * `reports.read` holder could already read.
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
    basePath = await mkdtemp(join(tmpdir(), 'openbooks-account-statements-'));
    setStorageProvider(createLocalStorageProvider({ provider: 'local', basePath }));
  });

  afterAll(async () => {
    setStorageProvider(undefined);
    if (basePath !== undefined) await rm(basePath, { recursive: true, force: true });
  });
}

const db = useServiceDatabase();
useLocalStorage();
const email = captureEmail();

const RECEIVABLES = '1100';
const SALES = '4000';

let sequence = 1n;

/** An approved, open invoice — the journal first, then the AR document that points at it. */
async function createOpenInvoice(
  scene: Scene,
  accounts: ReadonlyMap<string, { readonly id: string }>,
  contactId: string,
  issueDate: string,
  dueDate: string,
  amount: bigint,
): Promise<void> {
  const receivables = accounts.get(RECEIVABLES);
  const sales = accounts.get(SALES);
  if (receivables === undefined || sales === undefined) {
    throw new Error('The fixture chart is missing an account this helper needs.');
  }

  const journal = await post(scene, issueDate, [
    { accountId: receivables.id, side: 'debit', amount },
    { accountId: sales.id, side: 'credit', amount },
  ]);

  const id = newUuidBuffer();
  await db.app
    .insertInto('ar_documents')
    .values({
      id,
      org_id: scene.orgId,
      document_type: 'invoice',
      sequence_number: sequence++,
      contact_id: uuidToBuffer(contactId),
      issue_date: issueDate,
      due_date: dueDate,
      tax_mode: 'exclusive',
      reference: null,
      memo: null,
      journal_id: uuidToBuffer(journal.journalId),
      created_by_user_id: scene.userId,
    })
    .execute();

  await db.app
    .insertInto('ar_document_lines')
    .values({
      org_id: scene.orgId,
      document_id: id,
      line_number: 1,
      description: 'One line, no tax.',
      quantity_micros: 1_000_000n,
      unit_amount_minor: amount,
      account_id: uuidToBuffer(sales.id),
      tax_rate_id: null,
      line_amount_minor: amount,
      tax_amount_minor: 0n,
    })
    .execute();
}

/** A scene with the receivable/sales chart every fixture here posts against. */
async function sceneWithChart(): Promise<{
  readonly scene: Scene;
  readonly accounts: ReadonlyMap<string, { readonly id: string; readonly code: string }>;
}> {
  const scene = await createScene(db);
  const accounts = await createChart(scene, [
    { code: RECEIVABLES, type: 'asset', normalBalance: 'debit' },
    { code: SALES, type: 'revenue', normalBalance: 'credit' },
  ]);
  return { scene, accounts };
}

/** A custom role holding exactly the given permissions, for testing the `reports.read` gate. */
async function customRole(scene: Scene, permissions: readonly PermissionKey[]): Promise<string> {
  const roleUuid = newUuid();
  const roleId = uuidToBuffer(roleUuid);

  await db.app
    .insertInto('roles')
    .values({
      id: roleId,
      org_id: scene.orgId,
      code: `account-statements-role-${roleUuid.slice(0, 8)}`,
      name: 'Test role',
      description: 'Created by the OB-220 suite.',
      is_system: 0,
    })
    .execute();

  if (permissions.length > 0) {
    await db.app
      .insertInto('role_permissions')
      .values(permissions.map((code) => ({ role_id: roleId, permission_code: code })))
      .execute();
  }

  return roleUuid;
}

const AS_OF = '2026-06-30';

describe('createCustomerStatement', () => {
  it('renders a PDF, stores it, records the row, and closes at the open balance', async () => {
    const { scene, accounts } = await sceneWithChart();
    const contactId = await createParty(scene, 'Acme Co');

    await createOpenInvoice(scene, accounts, contactId, '2026-06-01', '2026-06-15', 15_000n);

    const created = await createCustomerStatement({ contactId, asOf: AS_OF }, scene.ctx);

    expect(created).toMatchObject({
      contactId,
      contactName: 'Acme Co',
      asOf: AS_OF,
      status: 'generated',
      recipientEmail: null,
      closingBalanceMinor: '15000',
      publicUrl: null,
    });
    expect(created.downloadUrl.length).toBeGreaterThan(0);
    expect(() => new URL(created.downloadUrl, 'https://example.test')).not.toThrow();

    const row = await db.app
      .selectFrom('customer_statements')
      .selectAll()
      .where('id', '=', uuidToBuffer(created.id))
      .executeTakeFirst();
    if (row === undefined) throw new Error('expected a persisted customer_statements row');

    expect(row.contact_id).toEqual(uuidToBuffer(contactId));
    expect(row.as_of).toBe(AS_OF);
    expect(row.status).toBe('generated');
    expect(row.key_prefix).toBeNull();
    expect(row.token_hash).toBeNull();
    expect(row.artifact_storage_key).toMatch(
      new RegExp(`^org/${scene.orgUuid}/statements/customer/[0-9a-f-]{36}\\.pdf$`),
    );

    const bytes = await storageProvider().get(row.artifact_storage_key);
    expect(bytes.length).toBeGreaterThan(0);
    expect(Buffer.from(bytes.subarray(0, 4)).toString('ascii')).toBe('%PDF');
  });

  it('renders an empty statement with a resolved name for a contact who owes nothing', async () => {
    const { scene } = await sceneWithChart();
    const contactId = await createParty(scene, 'Owes Nothing LLC');

    const created = await createCustomerStatement({ contactId, asOf: AS_OF }, scene.ctx);

    expect(created.contactName).toBe('Owes Nothing LLC');
    expect(created.closingBalanceMinor).toBe('0');
    expect(created.status).toBe('generated');
  });

  it('emails the statement when delivery is requested, and the hosted link resolves', async () => {
    const { scene, accounts } = await sceneWithChart();
    const contactId = await createParty(scene, 'Delivered Co');
    await createOpenInvoice(scene, accounts, contactId, '2026-06-01', '2026-06-15', 5_000n);

    const created = await createCustomerStatement(
      { contactId, asOf: AS_OF, delivery: { recipientEmail: 'ap@delivered.example' } },
      scene.ctx,
    );

    expect(created.status).toBe('sent');
    expect(created.recipientEmail).toBe('ap@delivered.example');

    const publicUrl = created.publicUrl;
    if (publicUrl === null) throw new Error('expected a publicUrl on a delivered statement');
    const publicPrefix = `${TEST_APP_BASE_URL}/public/statements/`;
    const publicSuffix = '/pdf';
    expect(publicUrl.startsWith(publicPrefix)).toBe(true);
    expect(publicUrl.endsWith(publicSuffix)).toBe(true);

    const message = email.to('ap@delivered.example');
    expect(message.text).toContain(publicUrl);

    const row = await db.app
      .selectFrom('customer_statements')
      .selectAll()
      .where('id', '=', uuidToBuffer(created.id))
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('sent');
    expect(row.recipient_email).toBe('ap@delivered.example');
    expect(row.key_prefix).not.toBeNull();
    expect(row.token_hash).not.toBeNull();

    const token = publicUrl.slice(publicPrefix.length, -publicSuffix.length);
    const artifact = await getPublicStatementArtifact(token);
    if (artifact === null) throw new Error('expected the token to resolve to the retained PDF');
    expect(Buffer.from(artifact.bytes.subarray(0, 4)).toString('ascii')).toBe('%PDF');

    expect(await getPublicStatementArtifact(`${token}wrong`)).toBeNull();
  });

  it('refuses a contact that does not belong to this org', async () => {
    const { scene: owner } = await sceneWithChart();
    const other = await createScene(db);
    const strangerContactId = await createParty(other, 'Someone Else’s Customer');

    await expect(
      createCustomerStatement({ contactId: strangerContactId, asOf: AS_OF }, owner.ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('requires reports.read', async () => {
    const { scene } = await sceneWithChart();
    const contactId = await createParty(scene, 'Gated Co');
    const roleUuid = await customRole(scene, ['invoices.read']);
    const ctx = contextFor(scene.orgUuid, roleUuid, scene.ctx.actorId);

    await expect(createCustomerStatement({ contactId, asOf: AS_OF }, ctx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    const rows = await db.app
      .selectFrom('customer_statements')
      .selectAll()
      .where('org_id', '=', scene.orgId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  it('refuses a caller with no user behind the request', async () => {
    const { scene } = await sceneWithChart();
    const contactId = await createParty(scene, 'Automation Co');
    const automationCtx: RequestContext = createRequestContext({
      orgId: scene.orgUuid,
      roleId: SYSTEM_ROLE_UUIDS.owner,
      userId: null,
      actorType: 'automation',
      actorId: 'account-statement-suite',
    });

    await expect(
      createCustomerStatement({ contactId, asOf: AS_OF }, automationCtx),
    ).rejects.toBeInstanceOf(UnauthenticatedError);
  });
});

describe('listCustomerStatements', () => {
  it('returns every statement for the org, newest first, narrowed by contactId', async () => {
    const { scene, accounts } = await sceneWithChart();
    const first = await createParty(scene, 'First Customer');
    const second = await createParty(scene, 'Second Customer');
    await createOpenInvoice(scene, accounts, first, '2026-06-01', '2026-06-15', 1_000n);
    await createOpenInvoice(scene, accounts, second, '2026-06-01', '2026-06-15', 2_000n);

    await createCustomerStatement({ contactId: first, asOf: AS_OF }, scene.ctx);
    await createCustomerStatement({ contactId: second, asOf: AS_OF }, scene.ctx);

    const all = await listCustomerStatements(undefined, scene.ctx);
    expect(all.statements).toHaveLength(2);
    for (const entry of all.statements) {
      expect(entry.downloadUrl.length).toBeGreaterThan(0);
      expect(entry.publicUrl).toBeNull();
    }

    const filtered = await listCustomerStatements(first, scene.ctx);
    expect(filtered.statements).toHaveLength(1);
    expect(filtered.statements[0]?.contactId).toBe(first);
    expect(filtered.statements[0]?.closingBalanceMinor).toBe('1000');
  });

  it("does not return another org's statements", async () => {
    const { scene: owner } = await sceneWithChart();
    const { scene: other, accounts: otherAccounts } = await sceneWithChart();
    const contactId = await createParty(other, 'Other Org Customer');
    await createOpenInvoice(other, otherAccounts, contactId, '2026-06-01', '2026-06-15', 1_000n);
    await createCustomerStatement({ contactId, asOf: AS_OF }, other.ctx);

    const list = await listCustomerStatements(undefined, owner.ctx);
    expect(list.statements).toHaveLength(0);
  });

  it('requires reports.read', async () => {
    const { scene } = await sceneWithChart();
    const roleUuid = await customRole(scene, ['invoices.read']);
    const ctx = contextFor(scene.orgUuid, roleUuid, scene.ctx.actorId);

    await expect(listCustomerStatements(undefined, ctx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });
});
