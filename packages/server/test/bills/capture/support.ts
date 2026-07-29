import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

import type { UploadCaptureRequest } from '@openbooks/shared-types';

import { createRequestContext, runInContext, type RequestContext } from '../../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../../src/db';
import type { DB } from '../../../src/db/generated';
import type { Logger } from '../../../src/logging';
import { registerDocumentExtractionJob } from '../../../src/modules/bills';
import {
  InProcessQueue,
  setDocumentExtractionProvider,
  setQueueProvider,
  setStorageProvider,
} from '../../../src/providers';
import { createDeterministicExtractionProvider } from '../../../src/providers/extraction/deterministic';
import { createLocalStorageProvider } from '../../../src/providers/storage/local';
import type { SystemRoleName, TestDatabase } from '../../db';
import {
  SYSTEM_ROLE_UUIDS,
  bufferToUuid,
  newUuidBuffer,
  systemRoleId,
  useTestDatabase,
} from '../../db';

/**
 * Support for the OB-186…190 capture suites.
 *
 * A deliberate duplicate of `test/bills/support.ts` and `test/branding/support.ts`
 * in its harness and storage scaffolding, following the convention those files
 * state: another ticket's fixtures, so this suite does not break when one of them
 * is edited.
 */

export function useServiceDatabase(): TestDatabase {
  const db = useTestDatabase();

  beforeAll(() => {
    if (!isDatabaseInitialized()) initializeDatabase(db.appConnectionConfig);
  });

  afterAll(async () => {
    await destroyDatabase();
  });

  return db;
}

/** Installs a `local` storage provider over a fresh temp directory for one file. */
export function useLocalStorage(): void {
  let basePath: string | undefined;

  beforeAll(async () => {
    basePath = await mkdtemp(join(tmpdir(), 'openbooks-capture-'));
    setStorageProvider(createLocalStorageProvider({ provider: 'local', basePath }));
    // Install the extraction provider through its seam, exactly as storage above:
    // a DB-level test builds its handles from the container directly and never
    // populates process.env, so a handler that resolved the provider through
    // getConfig() would throw ConfigValidationError. setDocumentExtractionProvider
    // is the sanctioned seam (spec §11 — real adapter, no mock).
    setDocumentExtractionProvider(createDeterministicExtractionProvider());
  });

  afterAll(async () => {
    setStorageProvider(undefined);
    setDocumentExtractionProvider(undefined);
    if (basePath !== undefined) await rm(basePath, { recursive: true, force: true });
  });
}

export const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

/**
 * Installs a fresh `InProcessQueue` with the extraction handler registered before
 * every test, exactly as `banking/statements/import.service.test.ts`'s `wire()`
 * does per-call — one queue instance per test, so a job left pending by one test
 * cannot bleed into the next.
 */
export function useExtractionQueue(): () => InProcessQueue {
  let current: InProcessQueue | undefined;

  beforeEach(async () => {
    const installed = new InProcessQueue(silentLogger);
    setQueueProvider(installed);
    await registerDocumentExtractionJob(installed, { logger: silentLogger });
    current = installed;
  });

  afterEach(() => {
    setQueueProvider(undefined);
    current = undefined;
  });

  return () => {
    if (current === undefined) {
      throw new Error("useExtractionQueue()'s beforeEach has not run yet.");
    }
    return current;
  };
}

export function contextFor(orgUuid: string, roleUuid: string, userUuid: string): RequestContext {
  return createRequestContext({
    orgId: orgUuid,
    roleId: roleUuid,
    userId: userUuid,
    actorType: 'user',
    actorId: userUuid,
  });
}

export function withContext<T>(ctx: RequestContext, body: () => Promise<T>): Promise<T> {
  return runInContext(ctx, body);
}

export interface CaptureScene {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
  readonly vendorUuid: string;
  readonly vendorId: Buffer;
  readonly expenseUuid: string;
  readonly expenseId: Buffer;
}

let codeSequence = 0;

/** An org with an open period, a vendor, and an expense account — enough to draft a bill. */
export async function sceneIn(
  db: TestDatabase,
  role: SystemRoleName = 'owner',
): Promise<CaptureScene> {
  const seq = (codeSequence += 1);
  const org = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  await db.factories.fiscalPeriod({ orgId: org.id });

  const expense = await db.factories.account({
    orgId: org.id,
    code: `6${String(seq).padStart(3, '0')}`,
    name: 'Office supplies',
    type: 'expense',
    normalBalance: 'debit',
  });

  const vendorId = await vendorIn(db, org.id, `Acme Supplies ${String(seq)}`);

  return {
    orgUuid: org.uuid,
    orgId: org.id,
    userUuid: user.uuid,
    userId: user.id,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    vendorUuid: bufferToUuid(vendorId),
    vendorId,
    expenseUuid: expense.uuid,
    expenseId: expense.id,
  };
}

/** A second member of the *same* org, holding a different seeded role — the permission suite's shape. */
export async function memberOf(
  db: TestDatabase,
  scene: CaptureScene,
  role: SystemRoleName,
): Promise<RequestContext> {
  const user = await db.factories.user();
  await db.factories.orgMember({
    orgId: scene.orgId,
    userId: user.id,
    roleId: systemRoleId(role),
  });
  return contextFor(scene.orgUuid, SYSTEM_ROLE_UUIDS[role], user.uuid);
}

export async function vendorIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
  flags: { readonly isVendor?: boolean; readonly isActive?: boolean } = {},
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({
      id,
      org_id: orgId,
      display_name: name,
      is_vendor: flags.isVendor === false ? 0 : 1,
      is_active: flags.isActive === false ? 0 : 1,
    })
    .execute();
  return id;
}

// ---------------------------------------------------------------------------
// The deterministic extraction format (`providers/extraction/deterministic.ts`)
// ---------------------------------------------------------------------------

export interface DeterministicLine {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmountMinor: string;
}

export interface DeterministicFields {
  readonly vendor?: string;
  readonly date?: string;
  readonly reference?: string;
  readonly tax?: string;
  readonly total?: string;
  readonly lines?: readonly DeterministicLine[];
}

/** Renders the `key: value` / `line: a | b | c` text the deterministic adapter parses. */
export function deterministicDocument(fields: DeterministicFields): string {
  const rows: string[] = [];
  if (fields.vendor !== undefined) rows.push(`vendor: ${fields.vendor}`);
  if (fields.date !== undefined) rows.push(`date: ${fields.date}`);
  if (fields.reference !== undefined) rows.push(`reference: ${fields.reference}`);
  if (fields.tax !== undefined) rows.push(`tax: ${fields.tax}`);
  if (fields.total !== undefined) rows.push(`total: ${fields.total}`);
  for (const line of fields.lines ?? []) {
    rows.push(`line: ${line.description} | ${line.quantity} | ${line.unitAmountMinor}`);
  }
  return rows.join('\n');
}

export function uploadRequestFor(
  fields: DeterministicFields,
  overrides: Partial<UploadCaptureRequest> = {},
): UploadCaptureRequest {
  return {
    filename: 'invoice.txt',
    contentType: 'application/pdf',
    content: Buffer.from(deterministicDocument(fields), 'utf8').toString('base64'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reading rows back directly (bypassing the service, for assertions)
// ---------------------------------------------------------------------------

export interface CaptureRow {
  readonly id: Buffer;
  readonly status: 'extracting' | 'extracted' | 'failed' | 'drafted' | 'dismissed';
  readonly matched_contact_id: Buffer | null;
  readonly extracted_vendor_name: string | null;
  readonly extraction_error: string | null;
  readonly drafted_bill_id: Buffer | null;
}

export async function captureRow(db: Kysely<DB>, id: Buffer): Promise<CaptureRow | undefined> {
  return db
    .selectFrom('document_captures')
    .select([
      'id',
      'status',
      'matched_contact_id',
      'extracted_vendor_name',
      'extraction_error',
      'drafted_bill_id',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
}
