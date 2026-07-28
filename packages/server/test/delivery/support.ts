import type { Invoice } from '@openbooks/shared-types';
import { afterAll, beforeAll } from 'vitest';

import { createRequestContext, runInContext, type RequestContext } from '../../src/context';
import { destroyDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db';
import { approveInvoice, createInvoice } from '../../src/modules/invoices';
import type { SystemRoleName, TestDatabase } from '../db';
import {
  bufferToUuid,
  newUuidBuffer,
  SYSTEM_ROLE_UUIDS,
  systemRoleId,
  useTestDatabase,
  uuidToBuffer,
} from '../db';

/**
 * Support for the delivery suite (OB-121).
 *
 * A deliberate duplicate of `test/invoices/support.ts`'s `useServiceDatabase` /
 * `contextFor` / `withContext` / `actorIn` / `scene`, following the convention that
 * file states: reaching sideways into another suite's fixtures means this suite
 * breaks when that one is edited. `scene` here is trimmed to what this suite needs
 * — one invoiceable org, ready to approve a line through — and drops the
 * dimension/allocation/concurrency helpers `invoices/support.ts` carries for its own
 * suites.
 *
 * The delivery suite needs a *real, approved* invoice — lines, tax, a posted
 * journal — because `getPublicInvoiceView` reads exactly what an authenticated
 * `getInvoice` would and the two ought to agree on a real one. Building that by hand
 * (a raw `INSERT` into `ar_documents` with a fabricated `journal_id`) would either
 * skip the ledger entirely or duplicate `postJournal`'s invariants badly; going
 * through `createInvoice`/`approveInvoice` is the same "prove it against the real
 * thing" argument spec §11 makes for using MySQL over a mock.
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

export interface ActorFixture {
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly userId: Buffer;
  readonly ctx: RequestContext;
}

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

/** Everything an AR document needs before it can be approved. */
export interface Scene {
  readonly actor: ActorFixture;
  readonly receivable: string;
  readonly income: string;
  readonly contact: string;
  readonly contactId: Buffer;
  /** 20%, exclusive. */
  readonly vat: string;
  readonly vatId: Buffer;
  readonly date: string;
}

export async function scene(db: TestDatabase): Promise<Scene> {
  const actor = await actorIn(db);
  const [period, receivable, income, taxLiability] = await Promise.all([
    db.factories.fiscalPeriod({ orgId: actor.orgId }),
    db.factories.account({
      orgId: actor.orgId,
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({ orgId: actor.orgId, type: 'revenue', normalBalance: 'credit' }),
    db.factories.account({ orgId: actor.orgId, type: 'liability', normalBalance: 'credit' }),
  ]);

  await db.factories.controlAccounts({ orgId: actor.orgId, receivableId: receivable.id });

  const contactId = await contactIn(db, actor.orgId);
  const vatId = await taxRateIn(db, actor.orgId, 'VAT 20%', 200_000, taxLiability.id);

  return {
    actor,
    receivable: receivable.uuid,
    income: income.uuid,
    contact: bufferToUuid(contactId),
    contactId,
    vat: bufferToUuid(vatId),
    vatId,
    date: period.startDate,
  };
}

export async function contactIn(
  db: TestDatabase,
  orgId: Buffer,
  name = 'Acme Ltd',
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('contacts')
    .values({ id, org_id: orgId, display_name: name, is_customer: 1 })
    .execute();
  return id;
}

export async function taxRateIn(
  db: TestDatabase,
  orgId: Buffer,
  name: string,
  ratePpm: number,
  taxAccountId: Buffer,
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('tax_rates')
    .values({
      id,
      org_id: orgId,
      name,
      rate_ppm: ratePpm,
      tax_account_id: taxAccountId,
      applies_to: 'both',
      is_active: 1,
    })
    .execute();
  return id;
}

/**
 * A real, approved invoice — priced, taxed, posted — the FKs `invoice_deliveries`
 * carries require (`fk_invoice_deliveries_org`, the composite
 * `fk_invoice_deliveries_invoice REFERENCES ar_documents (org_id, id)`): a delivery
 * row cannot be inserted for an org or an invoice id that does not really exist, so
 * every test in this suite that stores one needs a genuine `ar_documents` row behind
 * it, not a fabricated UUID.
 */
export interface ApprovedInvoiceFixture {
  readonly orgId: Buffer;
  readonly invoiceId: Buffer;
  readonly invoice: Invoice;
  readonly scene: Scene;
}

export async function approvedInvoiceIn(
  db: TestDatabase,
  overrides: { readonly reference?: string; readonly memo?: string } = {},
): Promise<ApprovedInvoiceFixture> {
  const s = await scene(db);

  return withContext(s.actor.ctx, async () => {
    const draft = await createInvoice({
      contactId: s.contact,
      issueDate: s.date,
      taxMode: 'exclusive',
      ...(overrides.reference === undefined ? {} : { reference: overrides.reference }),
      ...(overrides.memo === undefined ? {} : { memo: overrides.memo }),
      lines: [
        {
          description: 'Consulting',
          quantity: '2',
          unitAmount: '10000',
          accountId: s.income,
          taxRateId: s.vat,
        },
      ],
    });
    const invoice = await approveInvoice(draft.id);

    return { orgId: s.actor.orgId, invoiceId: uuidToBuffer(invoice.id), invoice, scene: s };
  });
}

/** Inserts an `invoice_deliveries` row directly, mirroring what `sendInvoice` (C1) will write. */
export async function deliveryIn(
  db: TestDatabase,
  input: {
    readonly orgId: Buffer;
    readonly invoiceId: Buffer;
    readonly keyPrefix: string;
    readonly tokenHash: Buffer;
    readonly artifactStorageKey: string;
    readonly recipientEmail?: string;
  },
): Promise<Buffer> {
  const id = newUuidBuffer();
  await db.app
    .insertInto('invoice_deliveries')
    .values({
      id,
      org_id: input.orgId,
      invoice_id: input.invoiceId,
      recipient_email: input.recipientEmail ?? 'customer@example.test',
      artifact_storage_key: input.artifactStorageKey,
      key_prefix: input.keyPrefix,
      token_hash: input.tokenHash,
      provider_message_id: null,
      status: 'sent',
    })
    .execute();
  return id;
}
