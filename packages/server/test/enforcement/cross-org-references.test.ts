import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { uuidToBuffer } from '../../src/db';
import {
  clearBankStatementLine,
  createBankAccount,
  createBankRule,
  createReconciliationSession,
  previewImportWithParsers,
  startImport,
  updateBankRule,
} from '../../src/modules/banking';
import { toWireError } from '../../src/errors';
import {
  CHART_TEMPLATE_IDS,
  createAccount,
  listChartTemplates,
  updateAccount,
} from '../../src/modules/accounts';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createVendorCredit,
  listBills,
  listVendorCredits,
  updateBill,
  updateVendorCredit,
} from '../../src/modules/bills';
import { createContact } from '../../src/modules/contacts';
import {
  createDimension,
  createDimensionValue,
  setJournalLineDimensions,
} from '../../src/modules/dimensions';
import { createDraft, listDrafts, updateDraft } from '../../src/modules/drafts';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  listCreditNotes,
  listInvoices,
  updateCreditNote,
  updateInvoice,
} from '../../src/modules/invoices';
import {
  createRecurringInvoiceTemplate,
  updateRecurringInvoiceTemplate,
} from '../../src/modules/invoicing';
import { postJournal } from '../../src/modules/ledger';
import { changeMemberRole, inviteMember } from '../../src/modules/members';
import { OWNER_ROLE_ID } from '../../src/modules/orgs';
import {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  listPayments,
  recordPayment,
} from '../../src/modules/payments';
import { getBalanceSheet, getGeneralLedger, getProfitAndLoss } from '../../src/modules/reports';
// Not through `modules/reports`' index — OB-065 never exported it and OB-067 did
// not either; `src/transport/routes/reports.ts` reaches for the file the same way.
import { getAging } from '../../src/modules/reports/aging.service';
import { updateControlAccounts } from '../../src/modules/settings';
import { createTaxRate, updateTaxRate } from '../../src/modules/tax';
import { InProcessQueue, setQueueProvider } from '../../src/providers';
import { generateOpenApiDocument } from '../../src/transport';
import { silentLogger } from '../banking/support';
import { newUuid } from '../db';
import { captureEmail } from '../members/support';
import { useServiceDatabase } from '../permissions/support';
import { buildTestApp } from '../transport/harness';
import { contextFor } from './support';

/**
 * **B11 / A7 — the ids that travel in a body or a query, not in a path.**
 *
 * `cross-org.test.ts` holds the A7 line for every operation addressed by
 * `/v1/{thing}/{id}`, derived from the path templates in the generated OpenAPI
 * document. This file is the complement, and the complement is the half that is
 * easy to miss: a *reference* — the parent an account is filed under, the contact a
 * draft line is with, the dimension a report is sliced by, the role a member is
 * moved to — is every bit as much an existence oracle as a path parameter, and it
 * has no `{brace}` in a route to make it visible.
 *
 * The coverage check below closes that by the same mechanism, one level deeper: it
 * walks the document's request bodies and query parameters for anything named like
 * an id, and requires each to be a row here or an entry in `EXEMPT` with a reason.
 * A new `POST /v1/things` whose body names a `contactId` fails this file before it
 * can ship as a leak.
 *
 * ## What "the same answer" is taken to mean
 *
 * `toWireError` output, compared as bytes, exactly as
 * `A7 at the service layer` does. Status codes are the weakest possible form of the
 * claim — two `404`s that differ in their `details` still tell an enumerator which
 * ids are real — and comparing what the error serializer produces is comparing what
 * every transport will send, HTTP today and MCP in M5.
 */
const db = useServiceDatabase();

// `startImport` enqueues; a queue with no handler drops the job rather than reaching a
// process config these service-layer tests never load.
beforeAll(() => {
  setQueueProvider(new InProcessQueue(silentLogger));
});
afterAll(() => {
  setQueueProvider(undefined);
});

captureEmail();

/** A syntactically valid id that belongs to nobody. Fixed, so a failure reproduces. */
const NOWHERE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const DATE = '2026-01-15';

/** One org's resources, as seen by whoever owns them. */
interface Org {
  readonly ctx: RequestContext;
  readonly orgUuid: string;
  readonly orgId: Buffer;
  readonly userUuid: string;
  readonly accountId: string;
  readonly revenueId: string;
  readonly contactId: string;
  readonly dimensionId: string;
  readonly dimensionValueId: string;
  readonly draftId: string;
  readonly journalLineId: string;
  /** A custom role in this org, which no other org may assign. */
  readonly customRoleId: string;

  /**
   * M3's references (OB-062 … OB-066a, on the wire since OB-067).
   *
   * Five more accounts than M2 needed, and they are not decoration: a control
   * account nomination is refused unless the account is of the right *type*
   * (`control-accounts.ts`), a tax rate posts to a liability, and a payment moves
   * money through a bank account. A fixture that reused the cash account for all of
   * them would turn several of the control passes below into `precondition_failed`
   * — which is not a 404 and would therefore pass, while proving nothing about the
   * id ever having been resolved.
   */
  readonly expenseId: string;
  readonly bankId: string;
  readonly receivableId: string;
  readonly payableId: string;
  readonly taxAccountId: string;
  /** Both flags, because the AR services refuse a non-customer and AP a non-vendor. */
  readonly partyId: string;
  readonly taxRateId: string;
  /** A draft-mode recurring template, so the `update*` reference rows have one to edit. */
  readonly recurringTemplateId: string;
  /** Approved, so it can be an allocation target and has room for three. */
  readonly invoiceId: string;
  readonly billId: string;
  readonly creditNoteId: string;
  readonly vendorCreditId: string;
  readonly paymentId: string;
  readonly draftInvoiceId: string;
  readonly draftCreditNoteId: string;
  readonly draftBillId: string;
  readonly draftVendorCreditId: string;

  /**
   * M4's references (OB-084). A bank account, a saved mapping, a journal with no
   * movement on the bank account (so a `link_entry` against it leaves a difference to
   * post), and six uncleared statement lines — one per `clearBankStatementLine` body
   * field, because the already-cleared check precedes body-ref validation and the `own`
   * control clears the line it touches.
   */
  readonly bankAccountId: string;
  readonly bankImportMappingId: string;
  readonly bankRuleId: string;
  readonly journalId: string;
  readonly differenceJournalId: string;
  readonly clearableLineIds: readonly string[];
}

/** One of the org's six uncleared lines, by index — asserted present. */
function clearable(o: Org, index: number): string {
  const id = o.clearableLineIds[index];
  if (id === undefined) throw new Error(`the scene has no clearable line ${String(index)}`);
  return id;
}

interface Scene {
  readonly caller: Org;
  readonly stranger: Org;
}

async function org(label: string): Promise<Org> {
  const record = await db.factories.org();
  const user = await db.factories.user();
  await db.factories.orgMember({ orgId: record.id, userId: user.id });

  const period = await db.factories.fiscalPeriod({ orgId: record.id });
  const cash = await db.factories.account({
    orgId: record.id,
    code: '1000',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenue = await db.factories.account({
    orgId: record.id,
    code: '4000',
    type: 'revenue',
    normalBalance: 'credit',
  });
  const [expense, bank, receivable, payable, taxAccount] = await Promise.all([
    db.factories.account({
      orgId: record.id,
      code: '5000',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({ orgId: record.id, code: '1010', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({ orgId: record.id, code: '1150', type: 'asset', normalBalance: 'debit' }),
    db.factories.account({
      orgId: record.id,
      code: '2050',
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: record.id,
      code: '2100',
      type: 'liability',
      normalBalance: 'credit',
    }),
  ]);

  const ctx = contextFor(record.uuid, OWNER_ROLE_ID, user.uuid);

  const posted = await runInContext(ctx, () =>
    postJournal(
      {
        date: period.startDate,
        actorType: 'user',
        actorId: user.uuid,
        lines: [
          { accountId: cash.uuid, side: 'debit', amount: 150000n },
          { accountId: revenue.uuid, side: 'credit', amount: 150000n },
        ],
      },
      ctx,
    ),
  );
  const line = posted.lines[0];
  if (line === undefined) throw new Error(`${label} setup posted no lines`);

  const contact = await runInContext(ctx, () => createContact({ displayName: 'Acme' }, ctx));
  const dimension = await runInContext(ctx, () =>
    createDimension({ code: 'DEPT', name: 'Department' }, ctx),
  );
  const value = await runInContext(ctx, () =>
    createDimensionValue(dimension.id, { code: 'SALES', name: 'Sales' }, ctx),
  );
  const draft = await runInContext(ctx, () => createDraft({ entryDate: period.startDate }, ctx));

  /**
   * A custom role, inserted directly because spec §5 defers the role editor to v2 —
   * there is no API that creates one. It is here because `roles` is the one table
   * `tenantDb` deliberately does not scope (its `org_id` is nullable and NULL means a
   * shared system role), so the org predicate is written by hand in two repositories,
   * and a hand-written predicate is one somebody can drop. `permissions.repository.ts`
   * says what dropping it costs: "a role id becomes a cross-tenant capability".
   */
  const customRoleId = newUuid();
  await db.migrator
    .insertInto('roles')
    .values({
      id: uuidToBuffer(customRoleId),
      org_id: record.id,
      code: `custom-${customRoleId.slice(0, 8)}`,
      name: 'Custom',
      description: 'A custom role, for the cross-tenant role-id assertion.',
      is_system: 0,
    })
    .execute();

  const subledger = await subledgerFixtures(record.id, ctx, {
    revenueId: revenue.uuid,
    expenseId: expense.uuid,
    bankId: bank.uuid,
    receivableId: receivable.uuid,
    payableId: payable.uuid,
    taxAccountId: taxAccount.uuid,
  });

  // --- OB-084 banking references ---
  //
  // A bank account on `bank`, a saved mapping, and six uncleared lines. The lines are
  // inserted directly (a statement line is only ever created by an import, OB-078). The
  // journal posted above has no line on `bank`, so linking it to a line leaves a
  // difference to post — which is what makes `differenceAccountId` a validated ref.
  const bankAccountId = newUuid();
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: uuidToBuffer(bankAccountId),
      org_id: record.id,
      account_id: uuidToBuffer(bank.uuid),
      name: 'Current account',
      external_account_id: null,
      is_active: 1,
    })
    .execute();

  const mappingId = newUuid();
  await db.app
    .insertInto('bank_import_mappings')
    .values({
      id: uuidToBuffer(mappingId),
      org_id: record.id,
      bank_account_id: uuidToBuffer(bankAccountId),
      name: 'Monthly export',
      has_header_row: 1,
      delimiter: ',',
      date_order: 'ymd',
      amount_convention: 'signed',
      posted_date_column: 0,
      description_column: 1,
      amount_column: 2,
    })
    .execute();

  const importId = newUuid();
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: uuidToBuffer(importId),
      org_id: record.id,
      bank_account_id: uuidToBuffer(bankAccountId),
      format: 'csv',
      filename: 'march.csv',
      file_hash: 'fixture',
      imported_by_user_id: user.id,
      status: 'complete',
      lines_read: 6,
      lines_duplicate: 0,
    })
    .execute();

  const clearableLineIds = await Promise.all(
    Array.from({ length: 6 }, async (_unused, index) => {
      const id = newUuid();
      await db.app
        .insertInto('bank_statement_lines')
        .values({
          id: uuidToBuffer(id),
          org_id: record.id,
          bank_account_id: uuidToBuffer(bankAccountId),
          import_id: uuidToBuffer(importId),
          posted_date: period.startDate,
          description: `LINE ${String(index)}`,
          amount_minor: -450n,
          fingerprint: `fixture-${String(index)}`,
          occurrence_index: 0,
        })
        .execute();
      return id;
    }),
  );

  // A second journal, also with no movement on `bank`, so the `differenceAccountId` row
  // can link one the `journalId` row has not already consumed (`uq_blc_journal`).
  const secondJournal = await runInContext(ctx, () =>
    postJournal(
      {
        date: period.startDate,
        actorType: 'user',
        actorId: user.uuid,
        lines: [
          { accountId: cash.uuid, side: 'debit', amount: 5000n },
          { accountId: revenue.uuid, side: 'credit', amount: 5000n },
        ],
      },
      ctx,
    ),
  );

  // A rule to be updated, so the `updateBankRule` body-ref rows have one to name in the
  // path while the id under test travels in the body.
  const bankRule = await runInContext(ctx, () =>
    createBankRule(
      {
        name: 'Base rule',
        condition: { description: { mode: 'contains', value: 'BASE' } },
        outcome: { accountId: cash.uuid },
      },
      ctx,
    ),
  );

  return {
    ctx,
    orgUuid: record.uuid,
    orgId: record.id,
    userUuid: user.uuid,
    accountId: cash.uuid,
    revenueId: revenue.uuid,
    contactId: contact.id,
    dimensionId: dimension.id,
    dimensionValueId: value.id,
    draftId: draft.id,
    journalLineId: line.lineId,
    customRoleId,
    expenseId: expense.uuid,
    bankId: bank.uuid,
    receivableId: receivable.uuid,
    payableId: payable.uuid,
    taxAccountId: taxAccount.uuid,
    bankAccountId,
    bankImportMappingId: mappingId,
    bankRuleId: bankRule.id,
    journalId: posted.journalId,
    differenceJournalId: secondJournal.journalId,
    clearableLineIds,
    ...subledger,
  };
}

/** The accounts M3's fixtures post against, resolved before any of them is built. */
interface SubledgerAccounts {
  readonly revenueId: string;
  readonly expenseId: string;
  readonly bankId: string;
  readonly receivableId: string;
  readonly payableId: string;
  readonly taxAccountId: string;
}

type SubledgerFixtures = Pick<
  Org,
  | 'billId'
  | 'creditNoteId'
  | 'draftBillId'
  | 'draftCreditNoteId'
  | 'draftInvoiceId'
  | 'draftVendorCreditId'
  | 'invoiceId'
  | 'partyId'
  | 'paymentId'
  | 'recurringTemplateId'
  | 'taxRateId'
  | 'vendorCreditId'
>;

/**
 * One org's AR and AP, through the real services.
 *
 * The control accounts are seeded through the factory rather than through
 * `updateControlAccounts`, which is the one place this file departs from building
 * fixtures the way production does — and deliberately: `updateControlAccounts` is
 * itself a row below, and a fixture that called it would be asserting against a
 * setting the rows under test can move.
 */
async function subledgerFixtures(
  orgId: Buffer,
  ctx: RequestContext,
  accounts: SubledgerAccounts,
): Promise<SubledgerFixtures> {
  await db.factories.controlAccounts({
    orgId,
    receivableId: uuidToBuffer(accounts.receivableId),
    payableId: uuidToBuffer(accounts.payableId),
  });

  const asOwner = <T>(body: () => Promise<T>): Promise<T> => runInContext(ctx, body);

  const party = await asOwner(() =>
    createContact({ displayName: 'Subledger Party', isCustomer: true, isVendor: true }, ctx),
  );
  const taxRate = await asOwner(() =>
    createTaxRate({ name: 'VAT 20%', percentage: '20', accountId: accounts.taxAccountId }, ctx),
  );

  const arLines = [
    {
      description: 'Consulting',
      quantity: '1',
      unitAmount: '100000',
      accountId: accounts.revenueId,
    },
  ];
  const apLines = [
    { description: 'Paper', quantity: '1', unitAmount: '100000', accountId: accounts.expenseId },
  ];
  const arInput = { contactId: party.id, issueDate: DATE, taxMode: 'exclusive' as const };

  const invoice = (): Promise<string> =>
    asOwner(async () => (await createInvoice({ ...arInput, lines: arLines }, ctx)).id);
  const creditNote = (): Promise<string> =>
    asOwner(async () => (await createCreditNote({ ...arInput, lines: arLines }, ctx)).id);
  const bill = (): Promise<string> =>
    asOwner(async () => (await createBill({ ...arInput, dueDate: DATE, lines: apLines }, ctx)).id);
  const vendorCredit = (): Promise<string> =>
    asOwner(async () => (await createVendorCredit({ ...arInput, lines: apLines }, ctx)).id);

  const approved = async (
    create: () => Promise<string>,
    approve: (id: string) => Promise<unknown>,
  ): Promise<string> => {
    const id = await create();
    await asOwner(() => approve(id));
    return id;
  };

  const invoiceId = await approved(invoice, (id) => approveInvoice(id, ctx));

  // A recurring template so the `update*` reference rows have an owned row to edit while
  // naming a stranger's contact/account/tax rate in the patch. Draft mode: it posts nothing.
  const recurringTemplateId = await asOwner(
    async () =>
      (
        await createRecurringInvoiceTemplate(
          {
            contactId: party.id,
            name: 'Monthly retainer',
            materializationMode: 'draft',
            taxMode: 'exclusive',
            frequency: 'monthly',
            intervalCount: 1,
            dueDays: 0,
            startDate: DATE,
            lines: [
              {
                description: null,
                quantity: '1',
                unitAmount: '150000',
                accountId: accounts.revenueId,
                taxRateId: null,
              },
            ],
          },
          ctx,
        )
      ).id,
  );

  return {
    partyId: party.id,
    taxRateId: taxRate.id,
    recurringTemplateId,
    invoiceId,
    billId: await approved(bill, (id) => approveBill(id, ctx)),
    creditNoteId: await approved(creditNote, (id) => approveCreditNote(id, ctx)),
    vendorCreditId: await approved(vendorCredit, (id) => approveVendorCredit(id, ctx)),
    draftInvoiceId: await invoice(),
    draftCreditNoteId: await creditNote(),
    draftBillId: await bill(),
    draftVendorCreditId: await vendorCredit(),
    // Ten times what any row applies: over-allocating a *document* is refused (C3)
    // and over-drawing the source with it, and either refusal is a
    // `precondition_failed` that would pass the control below while meaning the row
    // never reached a target at all.
    paymentId: await asOwner(
      async () =>
        (
          await recordPayment(
            {
              direction: 'received',
              contactId: party.id,
              date: DATE,
              amount: '1000000',
              accountId: accounts.bankId,
            },
            ctx,
          )
        ).id,
    ),
  };
}

/**
 * Removed rather than left behind: `roles` is a seeded table and the harness never
 * truncates it, so a custom role outlives its org and every later test in the
 * container.
 */
async function dropCustomRoles(scene: Scene): Promise<void> {
  const ids = [scene.caller.customRoleId, scene.stranger.customRoleId].map((id) =>
    uuidToBuffer(id),
  );

  // The `inviteMember` control issues a real invitation against the caller's own
  // custom role, and `fk_org_invites_role` is `ON DELETE RESTRICT` — correctly, since
  // an invitation naming a deleted role could not be accepted.
  await db.migrator.deleteFrom('org_invites').where('role_id', 'in', ids).execute();

  await db.migrator.deleteFrom('roles').where('id', 'in', ids).execute();
}

async function scene(): Promise<Scene> {
  return { caller: await org('caller'), stranger: await org('stranger') };
}

/**
 * One reference: an operation, the field an id reaches it through, and how to reach
 * it with an arbitrary id.
 *
 * `operationId` is null for a reference the wire does not carry yet. Both of them
 * are lines on `postJournal`: `JournalLineInput` grew a contact and its tags with
 * OB-059, and `JournalLineRequestInput` — the wire shape — has not. They are asserted
 * anyway, because M5's MCP tools reach this service without going through the route
 * schema, so "no route exposes it" is not a reason the id cannot arrive.
 */
interface Reference {
  readonly operationId: string | null;
  readonly field: string;
  /**
   * Which resource of an org the id under test is taken from.
   *
   * A function of one `Org` rather than a lookup keyed on `field`, which is what it
   * was through M2. M3 broke the keyed version outright: `targetId` appears on four
   * operations and means an invoice on three of them and a bill on the fourth, so a
   * name-to-resource table would have had to special-case the operation anyway. The
   * same function serves both directions — `subject(stranger)` is the id under test
   * and `subject(caller)` is the control — so a row cannot probe one resource and
   * control against another, which a two-table arrangement permits and nothing
   * would have caught.
   */
  readonly subject: (org: Org) => string;
  /** `id` is the id under test; `nonce` disambiguates rows that create something. */
  readonly reach: (id: string, scene: Scene, nonce: string) => Promise<unknown>;
}

const REFERENCES: readonly Reference[] = [
  {
    operationId: 'createAccount',
    field: 'parentAccountId',
    subject: (o) => o.accountId,
    reach: (id, s, nonce) =>
      createAccount(
        {
          code: `70${nonce}`,
          name: 'Child',
          type: 'asset',
          normalBalance: 'debit',
          parentAccountId: id,
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateAccount',
    field: 'parentAccountId',
    subject: (o) => o.accountId,
    reach: (id, s) => updateAccount(s.caller.revenueId, { parentAccountId: id }, s.caller.ctx),
  },
  {
    operationId: 'createDraft',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) =>
      createDraft(
        { entryDate: DATE, lines: [{ accountId: id, side: 'debit', amount: '100' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createDraft',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) =>
      createDraft(
        {
          entryDate: DATE,
          lines: [{ accountId: s.caller.accountId, side: 'debit', amount: '100', contactId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createDraft',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      createDraft(
        {
          entryDate: DATE,
          lines: [
            {
              accountId: s.caller.accountId,
              side: 'debit',
              amount: '100',
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateDraft',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) =>
      updateDraft(
        s.caller.draftId,
        { lines: [{ accountId: id, side: 'debit', amount: '100' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateDraft',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) =>
      updateDraft(
        s.caller.draftId,
        {
          lines: [{ accountId: s.caller.accountId, side: 'debit', amount: '100', contactId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateDraft',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      updateDraft(
        s.caller.draftId,
        {
          lines: [
            {
              accountId: s.caller.accountId,
              side: 'debit',
              amount: '100',
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'setJournalLineDimensions',
    field: 'valueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      setJournalLineDimensions(s.caller.journalLineId, { valueIds: [id] }, s.caller.ctx),
  },
  {
    operationId: 'postJournal',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) =>
      postJournal(
        {
          date: DATE,
          actorType: 'user',
          actorId: s.caller.userUuid,
          lines: [
            { accountId: id, side: 'debit', amount: 100n },
            { accountId: s.caller.revenueId, side: 'credit', amount: 100n },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: null,
    field: 'postJournal.lines.contactId',
    subject: (o) => o.contactId,
    reach: (id, s) =>
      postJournal(
        {
          date: DATE,
          actorType: 'user',
          actorId: s.caller.userUuid,
          lines: [
            { accountId: s.caller.accountId, side: 'debit', amount: 100n, contactId: id },
            { accountId: s.caller.revenueId, side: 'credit', amount: 100n },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: null,
    field: 'postJournal.lines.dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      postJournal(
        {
          date: DATE,
          actorType: 'user',
          actorId: s.caller.userUuid,
          lines: [
            {
              accountId: s.caller.accountId,
              side: 'debit',
              amount: 100n,
              dimensionValueIds: [id],
            },
            { accountId: s.caller.revenueId, side: 'credit', amount: 100n },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'changeMemberRole',
    field: 'roleId',
    subject: (o) => o.customRoleId,
    reach: (id, s) => changeMemberRole({ userId: s.caller.userUuid, roleId: id }, s.caller.ctx),
  },
  {
    operationId: 'inviteMember',
    field: 'roleId',
    subject: (o) => o.customRoleId,
    reach: (id, s, nonce) =>
      inviteMember({ email: `x${nonce}@openbooks.test`, roleId: id }, s.caller.ctx),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) => getGeneralLedger({ accountId: id }, s.caller.ctx),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) =>
      getGeneralLedger({ accountId: s.caller.accountId, contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'dimensions.dimensionId',
    subject: (o) => o.dimensionId,
    reach: (id, s) =>
      getGeneralLedger(
        {
          accountId: s.caller.accountId,
          dimensions: [{ dimensionId: id, includeUnassigned: true }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getGeneralLedger',
    field: 'dimensions.valueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      getGeneralLedger(
        {
          accountId: s.caller.accountId,
          dimensions: [{ dimensionId: s.caller.dimensionId, valueIds: [id] }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) => getProfitAndLoss({ contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'dimensions.dimensionId',
    subject: (o) => o.dimensionId,
    reach: (id, s) =>
      getProfitAndLoss(
        { dimensions: [{ dimensionId: id, includeUnassigned: true }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'dimensions.valueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      getProfitAndLoss(
        { dimensions: [{ dimensionId: s.caller.dimensionId, valueIds: [id] }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getProfitAndLoss',
    field: 'groupBy',
    subject: (o) => o.dimensionId,
    reach: (id, s) => getProfitAndLoss({ groupBy: id }, s.caller.ctx),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) => getBalanceSheet({ asOf: DATE, contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'dimensions.dimensionId',
    subject: (o) => o.dimensionId,
    reach: (id, s) =>
      getBalanceSheet(
        { asOf: DATE, dimensions: [{ dimensionId: id, includeUnassigned: true }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'dimensions.valueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      getBalanceSheet(
        { asOf: DATE, dimensions: [{ dimensionId: s.caller.dimensionId, valueIds: [id] }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'getBalanceSheet',
    field: 'groupBy',
    subject: (o) => o.dimensionId,
    reach: (id, s) => getBalanceSheet({ asOf: DATE, groupBy: id }, s.caller.ctx),
  },

  // ---------------------------------------------------------------------------
  // M3 (OB-062 … OB-066a, published by OB-067). Forty-three rows.
  //
  // This is the half of A7 that M3 made expensive to get wrong. A path id names a
  // document; the ids below name the *customer* the document is addressed to, the
  // account it posts to, the rate it is priced with, and the invoice a payment
  // settles — and every one of them is accepted in a body, where no `{brace}` in a
  // route makes it visible. `createInvoice` alone accepts four.
  //
  // Each row varies exactly one field and holds the rest at the caller's own, so a
  // 404 can only be about the field named. Written out rather than generated from
  // the four document kinds: a loop would have made the AR and AP shapes look
  // interchangeable, and they are not — a bill takes a `dueDate` and a vendor
  // credit does not, and its lines post to expense rather than revenue.
  // ---------------------------------------------------------------------------

  {
    operationId: 'createInvoice',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      createInvoice(
        {
          contactId: id,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createInvoice',
    field: 'accountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      createInvoice(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            { description: 'Consulting', quantity: '1', unitAmount: '100000', accountId: id },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createInvoice',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      createInvoice(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createInvoice',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      createInvoice(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateInvoice',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) => updateInvoice(s.caller.draftInvoiceId, { contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateInvoice',
    field: 'accountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      updateInvoice(
        s.caller.draftInvoiceId,
        {
          lines: [
            { description: 'Consulting', quantity: '1', unitAmount: '100000', accountId: id },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateInvoice',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      updateInvoice(
        s.caller.draftInvoiceId,
        {
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateInvoice',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      updateInvoice(
        s.caller.draftInvoiceId,
        {
          lines: [
            {
              description: 'Consulting',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createCreditNote',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      createCreditNote(
        {
          contactId: id,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Credit',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createCreditNote',
    field: 'accountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      createCreditNote(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [{ description: 'Credit', quantity: '1', unitAmount: '100000', accountId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createCreditNote',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      createCreditNote(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Credit',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createCreditNote',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      createCreditNote(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Credit',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateCreditNote',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) => updateCreditNote(s.caller.draftCreditNoteId, { contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateCreditNote',
    field: 'accountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      updateCreditNote(
        s.caller.draftCreditNoteId,
        {
          lines: [{ description: 'Credit', quantity: '1', unitAmount: '100000', accountId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateCreditNote',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      updateCreditNote(
        s.caller.draftCreditNoteId,
        {
          lines: [
            {
              description: 'Credit',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateCreditNote',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      updateCreditNote(
        s.caller.draftCreditNoteId,
        {
          lines: [
            {
              description: 'Credit',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.revenueId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  // Phase 4: recurring templates. Every id-shaped field a template body accepts —
  // `contactId` on the header, `accountId`/`taxRateId` on a line — on both create and update.
  // Dunning carries none (a stage names no ids).
  {
    operationId: 'createRecurringInvoiceTemplate',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      createRecurringInvoiceTemplate(
        {
          contactId: id,
          name: 'Monthly retainer',
          materializationMode: 'draft',
          taxMode: 'exclusive',
          frequency: 'monthly',
          intervalCount: 1,
          dueDays: 0,
          startDate: DATE,
          lines: [
            {
              description: null,
              quantity: '1',
              unitAmount: '150000',
              accountId: s.caller.revenueId,
              taxRateId: null,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createRecurringInvoiceTemplate',
    field: 'accountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      createRecurringInvoiceTemplate(
        {
          contactId: s.caller.partyId,
          name: 'Monthly retainer',
          materializationMode: 'draft',
          taxMode: 'exclusive',
          frequency: 'monthly',
          intervalCount: 1,
          dueDays: 0,
          startDate: DATE,
          lines: [
            {
              description: null,
              quantity: '1',
              unitAmount: '150000',
              accountId: id,
              taxRateId: null,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createRecurringInvoiceTemplate',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      createRecurringInvoiceTemplate(
        {
          contactId: s.caller.partyId,
          name: 'Monthly retainer',
          materializationMode: 'draft',
          taxMode: 'exclusive',
          frequency: 'monthly',
          intervalCount: 1,
          dueDays: 0,
          startDate: DATE,
          lines: [
            {
              description: null,
              quantity: '1',
              unitAmount: '150000',
              accountId: s.caller.revenueId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateRecurringInvoiceTemplate',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      updateRecurringInvoiceTemplate(s.caller.recurringTemplateId, { contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateRecurringInvoiceTemplate',
    field: 'accountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      updateRecurringInvoiceTemplate(
        s.caller.recurringTemplateId,
        {
          lines: [
            {
              description: null,
              quantity: '1',
              unitAmount: '150000',
              accountId: id,
              taxRateId: null,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateRecurringInvoiceTemplate',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      updateRecurringInvoiceTemplate(
        s.caller.recurringTemplateId,
        {
          lines: [
            {
              description: null,
              quantity: '1',
              unitAmount: '150000',
              accountId: s.caller.revenueId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBill',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      createBill(
        {
          contactId: id,
          issueDate: DATE,
          dueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBill',
    field: 'accountId',
    subject: (o) => o.expenseId,
    reach: (id, s) =>
      createBill(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          dueDate: DATE,
          taxMode: 'exclusive',
          lines: [{ description: 'Paper', quantity: '1', unitAmount: '100000', accountId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBill',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      createBill(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          dueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBill',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      createBill(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          dueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateBill',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) => updateBill(s.caller.draftBillId, { contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateBill',
    field: 'accountId',
    subject: (o) => o.expenseId,
    reach: (id, s) =>
      updateBill(
        s.caller.draftBillId,
        { lines: [{ description: 'Paper', quantity: '1', unitAmount: '100000', accountId: id }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateBill',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      updateBill(
        s.caller.draftBillId,
        {
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateBill',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      updateBill(
        s.caller.draftBillId,
        {
          lines: [
            {
              description: 'Paper',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createVendorCredit',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      createVendorCredit(
        {
          contactId: id,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Returned',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createVendorCredit',
    field: 'accountId',
    subject: (o) => o.expenseId,
    reach: (id, s) =>
      createVendorCredit(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [{ description: 'Returned', quantity: '1', unitAmount: '100000', accountId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createVendorCredit',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      createVendorCredit(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Returned',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createVendorCredit',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      createVendorCredit(
        {
          contactId: s.caller.partyId,
          issueDate: DATE,
          taxMode: 'exclusive',
          lines: [
            {
              description: 'Returned',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateVendorCredit',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      updateVendorCredit(s.caller.draftVendorCreditId, { contactId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateVendorCredit',
    field: 'accountId',
    subject: (o) => o.expenseId,
    reach: (id, s) =>
      updateVendorCredit(
        s.caller.draftVendorCreditId,
        {
          lines: [{ description: 'Returned', quantity: '1', unitAmount: '100000', accountId: id }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateVendorCredit',
    field: 'taxRateId',
    subject: (o) => o.taxRateId,
    reach: (id, s) =>
      updateVendorCredit(
        s.caller.draftVendorCreditId,
        {
          lines: [
            {
              description: 'Returned',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              taxRateId: id,
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateVendorCredit',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      updateVendorCredit(
        s.caller.draftVendorCreditId,
        {
          lines: [
            {
              description: 'Returned',
              quantity: '1',
              unitAmount: '100000',
              accountId: s.caller.expenseId,
              dimensionValueIds: [id],
            },
          ],
        },
        s.caller.ctx,
      ),
  },
  /**
   * The four `targetId` rows, and the reason `subject` is a function rather than a
   * table keyed on the field name: three of these mean an invoice and the fourth
   * means a bill, under one field name, because `createAllocationsRequestSchema`
   * carries `targetType` alongside it (D-39 — one mechanism for every source).
   */
  {
    operationId: 'allocatePayment',
    field: 'targetId',
    subject: (o) => o.invoiceId,
    reach: (id, s) =>
      allocatePayment(
        s.caller.paymentId,
        { allocations: [{ targetType: 'invoice', targetId: id, amount: '10000' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'allocateCreditNote',
    field: 'targetId',
    subject: (o) => o.invoiceId,
    reach: (id, s) =>
      allocateCreditNote(
        s.caller.creditNoteId,
        { allocations: [{ targetType: 'invoice', targetId: id, amount: '10000' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'allocateVendorCredit',
    field: 'targetId',
    subject: (o) => o.billId,
    reach: (id, s) =>
      allocateVendorCredit(
        s.caller.vendorCreditId,
        { allocations: [{ targetType: 'bill', targetId: id, amount: '10000' }] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'recordPayment',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) =>
      recordPayment(
        {
          direction: 'received',
          contactId: id,
          date: DATE,
          amount: '10000',
          accountId: s.caller.bankId,
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'recordPayment',
    field: 'accountId',
    subject: (o) => o.bankId,
    reach: (id, s) =>
      recordPayment(
        {
          direction: 'received',
          contactId: s.caller.partyId,
          date: DATE,
          amount: '10000',
          accountId: id,
        },
        s.caller.ctx,
      ),
  },
  /**
   * Recording and applying in one call, which is the shape `payments.ts` argues for
   * — and it is the one row where a leak would be worth the most to an outsider,
   * because a payment that recorded and *then* failed on an unresolvable target
   * would have distinguished a real invoice from an absent one by whether money
   * moved. The batch is all-or-nothing, and the equal wire errors below are what
   * says so from the caller's side.
   */
  {
    operationId: 'recordPayment',
    field: 'targetId',
    subject: (o) => o.invoiceId,
    reach: (id, s) =>
      recordPayment(
        {
          direction: 'received',
          contactId: s.caller.partyId,
          date: DATE,
          amount: '10000',
          accountId: s.caller.bankId,
          allocations: [{ targetType: 'invoice', targetId: id, amount: '10000' }],
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createTaxRate',
    field: 'accountId',
    subject: (o) => o.taxAccountId,
    reach: (id, s, nonce) =>
      createTaxRate({ name: `Rate ${nonce}`, percentage: '5', accountId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateTaxRate',
    field: 'accountId',
    subject: (o) => o.taxAccountId,
    reach: (id, s) => updateTaxRate(s.caller.taxRateId, { accountId: id }, s.caller.ctx),
  },
  /**
   * The two nominations, and they are the only rows here whose control pass writes
   * a setting the other rows depend on. It re-nominates what the org already holds,
   * so it exercises the resolution and moves nothing — a row that repointed the
   * receivable account would change where every `recordPayment` row above posts.
   */
  {
    operationId: 'updateControlAccounts',
    field: 'receivableControlAccountId',
    subject: (o) => o.receivableId,
    reach: (id, s) => updateControlAccounts({ receivableControlAccountId: id }, s.caller.ctx),
  },
  {
    operationId: 'updateControlAccounts',
    field: 'payableControlAccountId',
    subject: (o) => o.payableId,
    reach: (id, s) => updateControlAccounts({ payableControlAccountId: id }, s.caller.ctx),
  },
  /**
   * Aging's one id, and the row that says a *report* is not a way around the rule.
   * `aging.service.ts` resolves the contact through `assertFound` rather than
   * filtering on it, so an unknown contact and another org's are one 404 — the
   * alternative, an empty report, would have been the answer a filter gives and
   * would have said "this contact exists but owes you nothing" about a stranger's
   * customer.
   */
  {
    operationId: 'getAging',
    field: 'contactId',
    subject: (o) => o.partyId,
    reach: (id, s) => getAging({ asOf: DATE, ledger: 'receivable', contactId: id }, s.caller.ctx),
  },

  // ---------------------------------------------------------------------------
  // M4 (OB-084). Every id banking accepts in a body, each resolved by the service
  // (`assertFound`), so a cross-org value answers 404 byte-identical to a nonexistent
  // one. The list filters and the bank's own free-text `externalAccountId` are not
  // lookups; they are in `EXEMPT`.
  // ---------------------------------------------------------------------------

  {
    operationId: 'createBankAccount',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) => createBankAccount({ accountId: id, name: 'New account' }, s.caller.ctx),
  },
  {
    operationId: 'createReconciliationSession',
    field: 'bankAccountId',
    subject: (o) => o.bankAccountId,
    reach: (id, s) =>
      createReconciliationSession(
        { bankAccountId: id, endDate: DATE, statementClosingBalance: '0' },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'previewBankStatementImport',
    field: 'bankAccountId',
    subject: (o) => o.bankAccountId,
    reach: (id, s) =>
      previewImportWithParsers(
        { bankAccountId: id, format: 'ofx', filename: 'x.ofx', content: '<OFX></OFX>' },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'previewBankStatementImport',
    field: 'mappingId',
    subject: (o) => o.bankImportMappingId,
    reach: (id, s) =>
      previewImportWithParsers(
        {
          bankAccountId: s.caller.bankAccountId,
          format: 'csv',
          filename: 'x.csv',
          content: 'a,b,c\n',
          mappingId: id,
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'startBankStatementImport',
    field: 'bankAccountId',
    subject: (o) => o.bankAccountId,
    reach: (id, s) =>
      startImport(
        { bankAccountId: id, format: 'ofx', filename: 'x.ofx', content: '<OFX></OFX>' },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'startBankStatementImport',
    field: 'mappingId',
    subject: (o) => o.bankImportMappingId,
    reach: (id, s) =>
      startImport(
        {
          bankAccountId: s.caller.bankAccountId,
          format: 'csv',
          filename: 'x.csv',
          content: 'a,b,c\n',
          mappingId: id,
        },
        s.caller.ctx,
      ),
  },
  // clearBankStatementLine — one line per field, because the already-cleared check runs
  // before body-ref validation and the own control clears the line it touches.
  {
    operationId: 'clearBankStatementLine',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) =>
      clearBankStatementLine(
        clearable(s.caller, 0),
        { method: 'post_entry', accountId: id },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'clearBankStatementLine',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) =>
      clearBankStatementLine(
        clearable(s.caller, 1),
        { method: 'post_entry', accountId: s.caller.accountId, contactId: id },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'clearBankStatementLine',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      clearBankStatementLine(
        clearable(s.caller, 2),
        { method: 'post_entry', accountId: s.caller.accountId, dimensionValueIds: [id] },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'clearBankStatementLine',
    field: 'journalId',
    subject: (o) => o.journalId,
    reach: (id, s) =>
      clearBankStatementLine(
        clearable(s.caller, 3),
        { method: 'link_entry', journalId: id },
        s.caller.ctx,
      ),
  },
  // The journal here has no movement on the bank account, so the line's amount is all
  // difference — which is what makes `differenceAccountId` a validated ref rather than
  // an ignored one at a zero difference.
  {
    operationId: 'clearBankStatementLine',
    field: 'differenceAccountId',
    subject: (o) => o.revenueId,
    reach: (id, s) =>
      clearBankStatementLine(
        clearable(s.caller, 4),
        {
          method: 'link_entry',
          journalId: s.caller.differenceJournalId,
          differenceAccountId: id,
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'clearBankStatementLine',
    field: 'targetId',
    subject: (o) => o.invoiceId,
    reach: (id, s) =>
      clearBankStatementLine(
        clearable(s.caller, 5),
        { method: 'allocate_document', targetType: 'invoice', targetId: id },
        s.caller.ctx,
      ),
  },
  // createBankRule / updateBankRule — the account, contact, dimension value and bank
  // account named in a condition or an outcome, each resolved before the rule is written.
  {
    operationId: 'createBankRule',
    field: 'bankAccountId',
    subject: (o) => o.bankAccountId,
    reach: (id, s, nonce) =>
      createBankRule(
        {
          name: `Rule-bank-${nonce}`,
          condition: { bankAccountId: id, description: { mode: 'contains', value: 'X' } },
          outcome: { accountId: s.caller.accountId },
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBankRule',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s, nonce) =>
      createBankRule(
        {
          name: `Rule-account-${nonce}`,
          condition: { description: { mode: 'contains', value: 'X' } },
          outcome: { accountId: id },
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBankRule',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s, nonce) =>
      createBankRule(
        {
          name: `Rule-contact-${nonce}`,
          condition: { description: { mode: 'contains', value: 'X' } },
          outcome: { accountId: s.caller.accountId, contactId: id },
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'createBankRule',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s, nonce) =>
      createBankRule(
        {
          name: `Rule-dim-${nonce}`,
          condition: { description: { mode: 'contains', value: 'X' } },
          outcome: { accountId: s.caller.accountId, dimensionValueIds: [id] },
        },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateBankRule',
    field: 'bankAccountId',
    subject: (o) => o.bankAccountId,
    reach: (id, s) =>
      updateBankRule(
        s.caller.bankRuleId,
        { condition: { bankAccountId: id, description: { mode: 'contains', value: 'X' } } },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateBankRule',
    field: 'accountId',
    subject: (o) => o.accountId,
    reach: (id, s) =>
      updateBankRule(s.caller.bankRuleId, { outcome: { accountId: id } }, s.caller.ctx),
  },
  {
    operationId: 'updateBankRule',
    field: 'contactId',
    subject: (o) => o.contactId,
    reach: (id, s) =>
      updateBankRule(
        s.caller.bankRuleId,
        { outcome: { accountId: s.caller.accountId, contactId: id } },
        s.caller.ctx,
      ),
  },
  {
    operationId: 'updateBankRule',
    field: 'dimensionValueIds',
    subject: (o) => o.dimensionValueId,
    reach: (id, s) =>
      updateBankRule(
        s.caller.bankRuleId,
        { outcome: { accountId: s.caller.accountId, dimensionValueIds: [id] } },
        s.caller.ctx,
      ),
  },
];

/**
 * Query parameters that carry ids under a name no `…Id` pattern can see.
 *
 * The three reports take their dimension slice as a structured filter, JSON-encoded
 * into one parameter (`src/transport/routes/reports.ts` argues why), so `dimensions`
 * holds a `dimensionId` and a list of `valueIds` and `groupBy` holds a bare
 * dimension id. Listed by hand because a pattern cannot find them — which is the
 * whole reason they are the references most likely to be forgotten.
 */
const STRUCTURED_ID_PARAMS: readonly string[] = [
  'getBalanceSheet.dimensions.dimensionId',
  'getBalanceSheet.dimensions.valueIds',
  'getBalanceSheet.groupBy',
  'getGeneralLedger.dimensions.dimensionId',
  'getGeneralLedger.dimensions.valueIds',
  'getProfitAndLoss.dimensions.dimensionId',
  'getProfitAndLoss.dimensions.valueIds',
  'getProfitAndLoss.groupBy',
];

/**
 * References that are deliberately not rows here, each with the reason.
 *
 * An exemption is a claim that no cross-org id exists for the field, or that the
 * field is covered elsewhere — never that it was inconvenient.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // The chart templates are process constants (`CHART_TEMPLATES`), identical in every
  // org, so there is no per-org template and no cross-org id to ask about. Asserted
  // as such by `chart templates are the same in every org` below.
  'applyChartTemplate.templateId': 'a process constant, not a tenant row',
  'createOrg.chartTemplateId': 'a process constant, not a tenant row',
  'register.chartTemplateId': 'a process constant, not a tenant row',
  // The invite token is the credential; the caller is not a member of the org yet, so
  // there is no membership from which a cross-org read could be made. Covered by
  // `test/members/invites.service.test.ts`.
  'acceptInvite.orgId': 'reached by token, before any membership exists',
  // Already a row in `cross-org.test.ts` — the one there whose id travels in the body.
  'switchActiveOrg.orgId': 'covered by cross-org.test.ts',
  // A filter, not a lookup: see `answers a cross-org filter value exactly as it
  // answers an unknown one` below.
  'listDrafts.createdByUserId': 'a filter over the caller’s own org, asserted separately',
  /**
   * M3's five list filters, exempt for `listDrafts.createdByUserId`'s reason and
   * asserted with it.
   *
   * These are the rows where the right answer is the *opposite* of every other row
   * in this file, which is why they are named individually rather than matched by a
   * `list*` pattern. A `contactId` on a document collection narrows an org-scoped
   * query; a 404 would say the id names nobody, and that is the existence statement
   * A7 forbids — so the safe answer is the empty page an unknown id already gets.
   * `payments.service.ts` writes this out for the one case where it is not
   * automatic: a malformed contact filter returns `{ items: [], nextCursor: null }`
   * rather than a `validation_failed`, so the shape of an id is not an oracle
   * either.
   */
  'listInvoices.contactId': 'a filter over the caller’s own org, asserted separately',
  'listCreditNotes.contactId': 'a filter over the caller’s own org, asserted separately',
  'listBills.contactId': 'a filter over the caller’s own org, asserted separately',
  'listVendorCredits.contactId': 'a filter over the caller’s own org, asserted separately',
  'listPayments.contactId': 'a filter over the caller’s own org, asserted separately',
  /**
   * M4's banking filters (OB-084). Each answers an unknown or cross-org value with an
   * empty page rather than a 404 — the E9 uniform-filter behaviour every banking `list*`
   * chose deliberately — so a 404 is exactly what they must *not* give. `lineIds` on the
   * match-proposal request is the same shape one level in: unknown lines are dropped
   * from the answer, not reported as missing.
   */
  'listBankImportMappings.bankAccountId': 'a filter over the caller’s own org — empty, not 404',
  'listStatementLines.bankAccountId': 'a filter over the caller’s own org — empty, not 404',
  'listStatementLines.importId': 'a filter over the caller’s own org — empty, not 404',
  'listBankStatementImports.bankAccountId': 'a filter over the caller’s own org — empty, not 404',
  'listBankRules.bankAccountId': 'a filter over the caller’s own org — empty, not 404',
  'listReconciliationSessions.bankAccountId': 'a filter over the caller’s own org — empty, not 404',
  'proposeBankMatches.lineIds': 'a filter over a named set — unknown lines are dropped, not a 404',
  /**
   * Not a tenant reference at all: `externalAccountId` is the identifier the bank's own
   * file uses for the account (OFX's `ACCTID`), a free string held so an upload can be
   * checked against the account it is imported into. It is id-*shaped* but names no row,
   * so there is no cross-org read to make of it.
   */
  'createBankAccount.externalAccountId': 'a free-text bank identifier, not a tenant row',
  'updateBankAccount.externalAccountId': 'a free-text bank identifier, not a tenant row',
};

/** What every row must report. Anything else is the leak. */
interface Verdict {
  readonly status: number;
  readonly code: string;
  readonly matchesNonexistent: boolean;
  readonly echoesId: boolean;
  /** The control: the caller's *own* id through the same field must not 404. */
  readonly ownIdIsNotFound: boolean;
}

const SEALED = {
  status: 404,
  code: 'not_found',
  matchesNonexistent: true,
  echoesId: false,
  ownIdIsNotFound: false,
} as const satisfies Verdict;

/** The id in the stranger's org that each row is asked about. */
function crossOrgId(reference: Reference, s: Scene): string {
  return reference.subject(s.stranger);
}

/** The same resource in the caller's own org, for the control pass. */
function ownId(reference: Reference, s: Scene): string {
  return reference.subject(s.caller);
}

async function attempt(
  reference: Reference,
  s: Scene,
  id: string,
  nonce: string,
): Promise<unknown> {
  return runInContext(s.caller.ctx, () => reference.reach(id, s, nonce)).then(
    () => 'did not throw',
    (error: unknown) => toWireError(error),
  );
}

const key = (reference: Reference): string =>
  reference.operationId === null ? reference.field : `${reference.operationId}.${reference.field}`;

describe('B11 — a cross-org id in a body or a query answers as a nonexistent one', () => {
  it('gives every reference the same wire error for both', async () => {
    const s = await scene();
    try {
      const verdicts: Record<string, unknown> = {};
      for (const [index, reference] of REFERENCES.entries()) {
        const real = crossOrgId(reference, s);
        const cross = await attempt(reference, s, real, `c${String(index)}`);
        const nowhere = await attempt(reference, s, NOWHERE, `n${String(index)}`);
        const own = await attempt(reference, s, ownId(reference, s), `o${String(index)}`);

        const wire = cross as { status?: number; code?: string };
        verdicts[key(reference)] = {
          status: wire.status ?? 0,
          code: wire.code ?? 'did not throw',
          // Serialized before comparing, because the claim is about the bytes a
          // caller receives and not about two error objects being one object.
          matchesNonexistent: JSON.stringify(cross) === JSON.stringify(nowhere),
          echoesId: JSON.stringify(cross).includes(real),
          ownIdIsNotFound:
            typeof own === 'object' && own !== null && (own as { status?: number }).status === 404,
        };
      }

      expect(verdicts).toEqual(
        Object.fromEntries(REFERENCES.map((reference) => [key(reference), SEALED])),
      );
    } finally {
      await dropCustomRoles(s);
    }
  });

  /**
   * The converse, by the mechanism `cross-org.test.ts` established for path
   * parameters: derived from the generated document, so a reference added to the API
   * without a row is named here rather than discovered later.
   */
  it('covers every id-shaped field the API accepts in a body or a query', async () => {
    const built = await buildTestApp();
    try {
      const document = JSON.parse(await generateOpenApiDocument(built.app)) as OpenApiDocument;
      const declared = [...idBearingFields(document), ...STRUCTURED_ID_PARAMS].sort();

      const covered = [
        ...REFERENCES.filter((reference) => reference.operationId !== null).map(key),
        ...Object.keys(EXEMPT),
      ];

      expect([...new Set(covered)].sort()).toEqual([...new Set(declared)].sort());
      // An exemption is a claim that a field needs no row, so holding both would let
      // a row rot behind a reason saying it does not exist.
      const rows = new Set(
        REFERENCES.filter((reference) => reference.operationId !== null).map(key),
      );
      expect(Object.keys(EXEMPT).filter((field) => rows.has(field))).toEqual([]);
    } finally {
      await built.app.close();
    }
  });

  /**
   * `listDrafts?createdByUserId=` is the one id-shaped field that is a *filter*
   * rather than a lookup, and a filter must not 404 — a 404 would say the id names
   * nobody, which is precisely the existence statement A7 forbids. The safe answer
   * is the one an empty result gives, so that is what is asserted: a stranger's user
   * id and an id belonging to nobody produce the same empty page.
   */
  it('answers a cross-org filter value exactly as it answers an unknown one', async () => {
    const s = await scene();
    try {
      /**
       * Every filter in `EXEMPT`, run twice: once with an id that is real in the
       * stranger's org and once with an id that is real nowhere.
       *
       * Both results are compared as JSON *and* asserted empty, and the second half
       * is what stops the first from being vacuous — two identical pages would also
       * be identical if the filter were ignored entirely and both returned the
       * caller's whole collection, which is a different bug and a worse one.
       */
      const filters: readonly {
        readonly field: string;
        readonly list: (id: string) => Promise<{ readonly items: readonly unknown[] }>;
      }[] = [
        {
          field: 'listDrafts.createdByUserId',
          list: (id) => listDrafts({ createdByUserId: id }, s.caller.ctx),
        },
        {
          field: 'listInvoices.contactId',
          list: (id) => listInvoices({ contactId: id }, s.caller.ctx),
        },
        {
          field: 'listCreditNotes.contactId',
          list: (id) => listCreditNotes({ contactId: id }, s.caller.ctx),
        },
        { field: 'listBills.contactId', list: (id) => listBills({ contactId: id }, s.caller.ctx) },
        {
          field: 'listVendorCredits.contactId',
          list: (id) => listVendorCredits({ contactId: id }, s.caller.ctx),
        },
        {
          field: 'listPayments.contactId',
          list: (id) => listPayments({ contactId: id }, s.caller.ctx),
        },
      ];

      // The user-shaped filter is the one exception to "ask about the stranger's
      // contact": `listDrafts` filters on who composed a draft, so the cross-org
      // value has to be a user.
      const strangerValue = (field: string): string =>
        field === 'listDrafts.createdByUserId' ? s.stranger.userUuid : s.stranger.partyId;

      const verdicts: Record<string, unknown> = {};
      for (const { field, list } of filters) {
        const forStranger = await runInContext(s.caller.ctx, () => list(strangerValue(field)));
        const forNobody = await runInContext(s.caller.ctx, () => list(NOWHERE));

        verdicts[field] = {
          matchesUnknown: JSON.stringify(forStranger) === JSON.stringify(forNobody),
          items: forStranger.items.length,
        };
      }

      expect(verdicts).toEqual(
        Object.fromEntries(filters.map(({ field }) => [field, { matchesUnknown: true, items: 0 }])),
      );

      // And the caller's *own* contact does return rows, which is what makes the
      // empty pages above a statement about ownership rather than about a filter
      // that matches nothing at all.
      const mine = await runInContext(s.caller.ctx, () =>
        listInvoices({ contactId: s.caller.partyId }, s.caller.ctx),
      );
      expect(mine.items.length).toBeGreaterThan(0);
    } finally {
      await dropCustomRoles(s);
    }
  });

  /**
   * The chart templates, which the ticket lists among M2's resources and which have
   * no cross-org id by construction: they are `CHART_TEMPLATES`, a process constant.
   * Stated as a test rather than as a comment, because the moment a template becomes
   * a tenant row it acquires an id worth enumerating, and this is what notices.
   */
  it('offers every org the identical set of chart templates', async () => {
    const s = await scene();
    try {
      const mine = await runInContext(s.caller.ctx, () => listChartTemplates(s.caller.ctx));
      const theirs = await runInContext(s.stranger.ctx, () => listChartTemplates(s.stranger.ctx));

      expect(JSON.stringify(mine)).toBe(JSON.stringify(theirs));

      // And the ids are the compile-time constant, not rows: there is no table a
      // template could belong to an org through, which is what makes "no cross-org
      // id exists" a statement about the schema rather than about two fixtures
      // happening to agree.
      expect(mine.map((template) => template.id).sort()).toEqual([...CHART_TEMPLATE_IDS].sort());
    } finally {
      await dropCustomRoles(s);
    }
  });
});

interface OpenApiDocument {
  readonly paths: Record<
    string,
    Record<
      string,
      {
        readonly operationId: string;
        readonly parameters?: readonly { readonly in: string; readonly name: string }[];
        readonly requestBody?: {
          readonly content?: Record<string, { readonly schema?: JsonSchema }>;
        };
      }
    >
  >;
  readonly components: { readonly schemas: Record<string, JsonSchema> };
}

interface JsonSchema {
  readonly $ref?: string;
  readonly properties?: Record<string, JsonSchema>;
  readonly items?: JsonSchema;
  readonly allOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
}

const ID_SHAPED = /Ids?$/;

/** `operationId.field` for every id-shaped body property and query parameter. */
function idBearingFields(document: OpenApiDocument): readonly string[] {
  const found: string[] = [];

  for (const item of Object.values(document.paths)) {
    for (const operation of Object.values(item)) {
      const fields = new Set<string>();
      const seen = new Set<string>();

      const walk = (schema: JsonSchema | undefined): void => {
        if (schema === undefined) return;
        if (schema.$ref !== undefined) {
          if (seen.has(schema.$ref)) return;
          seen.add(schema.$ref);
          walk(document.components.schemas[schema.$ref.split('/').pop() as string]);
          return;
        }
        for (const [name, property] of Object.entries(schema.properties ?? {})) {
          if (ID_SHAPED.test(name)) fields.add(name);
          walk(property);
        }
        walk(schema.items);
        for (const branch of [
          ...(schema.allOf ?? []),
          ...(schema.oneOf ?? []),
          ...(schema.anyOf ?? []),
        ]) {
          walk(branch);
        }
      };

      walk(operation.requestBody?.content?.['application/json']?.schema);
      for (const parameter of operation.parameters ?? []) {
        if (parameter.in === 'query' && ID_SHAPED.test(parameter.name)) fields.add(parameter.name);
      }

      for (const field of fields) found.push(`${operation.operationId}.${field}`);
    }
  }

  return found;
}
