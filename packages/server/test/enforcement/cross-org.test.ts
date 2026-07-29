import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runInContext } from '../../src/context';
import { newUuid, uuidToBuffer } from '../../src/db';
import { toWireError } from '../../src/errors';
import { getAccount } from '../../src/modules/accounts';
import { reverseJournal } from '../../src/modules/ledger';
import { OWNER_ROLE_ID, resolveOrgMembership } from '../../src/modules/orgs';
import { getPeriod } from '../../src/modules/periods';
import {
  createLocalSecretsProvider,
  setSecretsProvider,
  storageProvider,
} from '../../src/providers';
import { generateOpenApiDocument } from '../../src/transport';
import type { App } from '../../src/transport';
import type { Session } from '../transport/v1-support';
import { authorizedWrite, createAccount, registerUser, useV1App } from '../transport/v1-support';
import { contextFor } from './support';

/**
 * **Acceptance A7 — a cross-org read returns nothing and does not leak existence** —
 * as one matrix over every surface that takes a resource id.
 *
 * A7's failure mode is not a single missing check, it is *one* surface out of step
 * with the others: a resource whose route answers `403`, or `404` with a different
 * body, or echoes the id it was asked about, is an oracle for the existence of another
 * tenant's objects. Whether a system has that oracle is a property of the whole
 * surface, so it is asserted as a whole here rather than resource by resource.
 * `test/transport/v1.test.ts` makes the claim for `GET /v1/accounts/{id}` and
 * `test/ledger/posting.test.ts` makes it for accounts and journals at the service
 * layer; those are not rewritten, they are subsumed — the point of consolidating is
 * that a resource type added without a row here is visible, which is what
 * `covers every operation that takes a resource id` below enforces.
 *
 * ## What "does not leak existence" is taken to mean
 *
 * Byte-identical, not merely equal in status. Two `404`s whose bodies differ, or whose
 * `content-type` differs, still distinguish "not yours" from "never existed" to anyone
 * who diffs them — and `resolveOrgMembership` says exactly this about the org
 * switcher, which would otherwise enumerate every tenant in the system. So each row
 * compares the raw body string, the content type, and asserts the real id appears
 * nowhere in the response.
 */
const harness = useV1App();

// `connectProcessor` (OB-150) writes through the secrets provider (D-101), which
// `useV1App` does not install — installed directly here, the way its own storage and
// email adapters are, rather than through `getConfig()`: a throwaway `local` adapter
// and encryption key, since this file's process-wide config is never resolved for
// its own sake.
beforeAll(() => {
  setSecretsProvider(
    createLocalSecretsProvider({ provider: 'local', encryptionKey: 'k'.repeat(32) }),
  );
});
afterAll(() => {
  setSecretsProvider(undefined);
});

/** A syntactically valid id that belongs to nobody. Fixed, so a failure is reproducible. */
const NOWHERE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

interface Scene {
  readonly stranger: Awaited<ReturnType<typeof registerUser>>;
  readonly owner: Awaited<ReturnType<typeof registerUser>>;
  readonly accountId: string;
  readonly periodId: string;
  readonly journalId: string;
  readonly journalLineId: string;
  readonly contactId: string;
  readonly dimensionId: string;
  readonly dimensionValueId: string;
  /** Posted by the control pass, which consumes it. */
  readonly draftId: string;
  /**
   * A second draft, because two operations destroy one and the control pass runs
   * both: posting a draft deletes it (D-19) and discarding it deletes it. Sharing a
   * row would make whichever ran second answer `404` for the *owner*, which is the
   * one thing `ownerGetsNotFound` exists to catch.
   */
  readonly discardableDraftId: string;
  readonly inviteId: string;
  readonly recurringTemplateId: string;
  readonly dunningPolicyId: string;

  /**
   * M3's fixtures (OB-067's routes, OB-062 … OB-066's services).
   *
   * One document per operation rather than one per kind, which is the same
   * arrangement `permission-matrix.test.ts` arrived at and for a related reason. The
   * constraint here is the *control* pass: the owner runs every row against their
   * own resource and `ownerGetsNotFound` must stay false, so a row that approved,
   * voided or discarded a document another row later names would turn that row's
   * control into a 404 — and a 404 in the control pass is indistinguishable from
   * the leak this file exists to detect.
   */
  readonly partyId: string;
  readonly taxRateId: string;
  readonly targetInvoiceId: string;
  readonly draftInvoiceId: string;
  readonly approvableInvoiceId: string;
  readonly voidableInvoiceId: string;
  readonly discardableInvoiceId: string;
  readonly allocatableCreditNoteId: string;
  readonly draftCreditNoteId: string;
  readonly approvableCreditNoteId: string;
  readonly voidableCreditNoteId: string;
  readonly discardableCreditNoteId: string;
  readonly targetBillId: string;
  readonly draftBillId: string;
  readonly approvableBillId: string;
  readonly voidableBillId: string;
  readonly discardableBillId: string;
  readonly allocatableVendorCreditId: string;
  readonly draftVendorCreditId: string;
  readonly approvableVendorCreditId: string;
  readonly voidableVendorCreditId: string;
  readonly discardableVendorCreditId: string;
  readonly paymentId: string;
  readonly voidablePaymentId: string;
  readonly allocationId: string;

  /**
   * M4's fixtures (OB-084). Every one exists in the owner's org so the control pass
   * resolves it rather than 404ing — which is what makes the stranger's 404 a statement
   * about ownership. The lines, their clearing, the import and the session are inserted
   * directly: a statement line is only ever created by an import (OB-078), and there is
   * no HTTP path to one.
   */
  readonly bankAccountId: string;
  readonly bankImportMappingId: string;
  readonly bankImportId: string;
  readonly bankRuleId: string;
  readonly statementLineId: string;
  readonly clearedStatementLineId: string;
  readonly reconciliationSessionId: string;

  /**
   * OCR bill capture (initiative O, OB-186…190). Three `document_captures` rows —
   * one per row that consumes its capture (`dismissBillCapture` to `dismissed`,
   * `createDraftFromBillCapture` to `drafted`) — so the control pass for one row
   * cannot leave the next row's capture already reviewed, `discardableDraftId`'s
   * reason one subsystem over. `billAttachmentId` is on `targetBillId`, the
   * already-approved bill `getBill` also reads.
   */
  readonly billCaptureId: string;
  readonly dismissibleBillCaptureId: string;
  readonly draftableBillCaptureId: string;
  readonly billAttachmentId: string;

  /**
   * M5 (OB-097…104): the platform surface's own id-addressed resources.
   * `oauthClientPublicId` is the `client_id` OAuth string `revokeConnectedApp`
   * addresses by — `deactivateOAuthClient`'s row below still uses the REST `id`
   * (`oauthClientId`) — the same asymmetry `oauth-clients.ts`'s file header states.
   * `approvableProposalId`/`rejectableProposalId` are two drafts rather than one,
   * `draftId`/`discardableDraftId`'s reason: approving posts one and consumes it,
   * rejecting discards the other, and the control pass runs both.
   */
  readonly apiKeyId: string;
  readonly oauthClientId: string;
  readonly oauthClientPublicId: string;
  readonly approvableProposalId: string;
  readonly rejectableProposalId: string;

  /**
   * Payment integration (OB-150): a `fake` processor connection, for
   * `getProcessorConnection`/`deactivateProcessorConnection`/
   * `reactivateProcessorConnection` to answer about across orgs.
   */
  readonly processorConnectionId: string;
}

/**
 * Two orgs, and one of every resource type in the first.
 *
 * Built once inside each test rather than in a `beforeAll`, because the harness
 * truncates before every test — and registration hashes a password with Argon2, which
 * is the dominant cost in this file, so the matrix runs as one test over many rows
 * instead of many tests over one row each.
 */
async function scene(app: App): Promise<Scene> {
  const owner = await registerUser(app, { email: 'a7-owner@example.invalid', orgName: 'Owner' });
  const stranger = await registerUser(app, {
    email: 'a7-stranger@example.invalid',
    orgName: 'Stranger',
  });

  const accountId = await createAccount(app, owner, {
    code: '1000',
    name: 'Cash',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenueId = await createAccount(app, owner, {
    code: '4000',
    name: 'Sales',
    type: 'revenue',
    normalBalance: 'credit',
  });

  const year = await app.inject({
    method: 'POST',
    url: '/v1/fiscal-years',
    headers: authorizedWrite(owner, 'a7-year'),
    payload: { fiscalYear: 2026 },
  });
  const periodId = year.json<{ periods: { id: string }[] }>().periods[0]?.id;

  const posted = await app.inject({
    method: 'POST',
    url: '/v1/journals',
    headers: authorizedWrite(owner, 'a7-journal'),
    payload: {
      date: '2026-03-31',
      lines: [
        { accountId, side: 'debit', amount: '150000' },
        { accountId: revenueId, side: 'credit', amount: '150000' },
      ],
    },
  });
  const journalId = posted.json<{ journalId: string }>().journalId;
  const journalLineId = posted.json<{ lines: { lineId: string }[] }>().lines[0]?.lineId;

  if (periodId === undefined) throw new Error(`fiscal year setup failed: ${year.body}`);
  if (posted.statusCode !== 201) throw new Error(`journal setup failed: ${posted.body}`);
  if (journalLineId === undefined) throw new Error(`journal setup returned no lines`);

  const created = async (
    label: string,
    url: string,
    payload: Record<string, unknown>,
  ): Promise<string> => {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: authorizedWrite(owner, `a7-setup-${label}`),
      payload,
    });
    if (response.statusCode !== 201) {
      throw new Error(`${label} setup failed: ${String(response.statusCode)} ${response.body}`);
    }
    return response.json<{ id: string }>().id;
  };

  // Deliberately named by nothing: `deleteContact` is one of the rows below, and the
  // control pass has to reach a `204` rather than the `precondition_failed` a contact
  // on a posting or a draft line earns.
  const contactId = await created('contact', '/v1/contacts', { displayName: 'Acme' });
  const dimensionId = await created('dimension', '/v1/dimensions', {
    code: 'DEPT',
    name: 'Department',
  });
  const dimensionValueId = await created('value', `/v1/dimensions/${dimensionId}/values`, {
    code: 'SALES',
    name: 'Sales',
  });

  const draft = {
    entryDate: '2026-03-31',
    lines: [
      { accountId, side: 'debit', amount: '100' },
      { accountId: revenueId, side: 'credit', amount: '100' },
    ],
  };
  const draftId = await created('draft', '/v1/journal-drafts', draft);
  const discardableDraftId = await created('draft-2', '/v1/journal-drafts', draft);

  const invited = await app.inject({
    method: 'POST',
    url: '/v1/invites',
    headers: authorizedWrite(owner, 'a7-setup-invite'),
    payload: { email: 'a7-invited@example.invalid', roleId: OWNER_ROLE_ID },
  });
  if (invited.statusCode !== 201) throw new Error(`invite setup failed: ${invited.body}`);
  const inviteId = invited.json<{ invitation: { id: string } }>().invitation.id;

  // Phase 4: a recurring template and a dunning policy, so the matrix can prove their
  // id-addressed routes 404 across orgs. Neither posts anything — a `draft`-mode template only
  // stores its schedule — so both simply exist for the owner to resolve and the stranger not to.
  const recurringTemplateId = await created('recurring', '/v1/recurring-invoices', {
    contactId,
    name: 'Monthly retainer',
    materializationMode: 'draft',
    taxMode: 'exclusive',
    frequency: 'monthly',
    intervalCount: 1,
    dueDays: 0,
    startDate: '2026-01-15',
    lines: [
      {
        description: null,
        quantity: '1',
        unitAmount: '150000',
        accountId: revenueId,
        taxRateId: null,
      },
    ],
  });
  const dunningPolicyId = await created('dunning', '/v1/dunning-policies', {
    name: 'Standard ladder',
    stages: [
      { stageNumber: 1, offsetDays: 7, subject: 'Reminder', body: 'Overdue.', lateFeeMinor: null },
    ],
  });

  const subledger = await subledgerScene(app, owner, created, revenueId);
  const banking = await bankingScene(app, owner, created, revenueId, journalId);
  const captures = await captureScene(owner, subledger.targetBillId);

  // M5 (OB-097…104): a key and a client, so `revokeApiKey`/`deactivateOAuthClient`/
  // `revokeConnectedApp` have a resource to answer about across orgs, and two more
  // proposal drafts for the review-queue rows — `draftId`/`discardableDraftId`'s
  // reason, one subsystem over: approving posts and consumes one, rejecting
  // discards the other, and the control pass runs both.
  const apiKeyId = await created('api-key', '/v1/api-keys', {
    name: 'A7 fixture key',
    roleId: OWNER_ROLE_ID,
  });

  const oauthClientResponse = await app.inject({
    method: 'POST',
    url: '/v1/oauth-clients',
    headers: authorizedWrite(owner, 'a7-setup-oauth-client'),
    payload: { name: 'A7 Fixture Client', redirectUris: ['https://example.invalid/callback'] },
  });
  if (oauthClientResponse.statusCode !== 201) {
    throw new Error(`oauth client setup failed: ${oauthClientResponse.body}`);
  }
  const oauthClientBody = oauthClientResponse.json<{ id: string; clientId: string }>();
  const oauthClientId = oauthClientBody.id;
  const oauthClientPublicId = oauthClientBody.clientId;

  const proposal = {
    entryDate: '2026-03-31',
    lines: [
      { accountId, side: 'debit', amount: '100' },
      { accountId: revenueId, side: 'credit', amount: '100' },
    ],
  };
  const approvableProposalId = await created('proposal-approve', '/v1/journal-drafts', proposal);
  const rejectableProposalId = await created('proposal-reject', '/v1/journal-drafts', proposal);

  // Payment integration (OB-150): a `fake` connection, nominating the two accounts
  // the scene already built rather than dedicated ones — `connectProcessor` only
  // checks that an account is active, so there is nothing a fresh pair would prove
  // that `accountId`/`revenueId` do not already.
  const processorConnectionId = await created(
    'processor-connection',
    '/v1/processing/connections',
    {
      processor: 'fake',
      clearingAccountId: revenueId,
      feeAccountId: accountId,
      secretKey: 'sk_test_a7_fixture',
      webhookSecret: 'whsec_a7_fixture',
    },
  );

  return {
    owner,
    stranger,
    accountId,
    periodId,
    journalId,
    journalLineId,
    contactId,
    dimensionId,
    dimensionValueId,
    draftId,
    discardableDraftId,
    inviteId,
    recurringTemplateId,
    dunningPolicyId,
    apiKeyId,
    oauthClientId,
    oauthClientPublicId,
    approvableProposalId,
    rejectableProposalId,
    processorConnectionId,
    ...subledger,
    ...banking,
    ...captures,
  };
}

/** Everything `captureScene` contributes: OCR bill capture's half of the scene. */
type CaptureScene = Pick<
  Scene,
  'billAttachmentId' | 'billCaptureId' | 'dismissibleBillCaptureId' | 'draftableBillCaptureId'
>;

/**
 * OCR bill capture's fixtures (initiative O, OB-186…190), inserted directly rather
 * than through `createCaptureFromUpload`: that call enqueues extraction and returns
 * a row at `extracting`, and the review routes under test here need one already
 * `extracted` — `bankingScene`'s reason for writing `bank_statement_lines` by hand
 * applies the same way, one milestone over.
 */
async function captureScene(owner: Session, targetBillId: string): Promise<CaptureScene> {
  const db = harness.db;
  const orgId = uuidToBuffer(owner.orgId);
  const userId = uuidToBuffer(owner.userId);

  const extractedCapture = async (label: string): Promise<string> => {
    const id = newUuid();
    await db.app
      .insertInto('document_captures')
      .values({
        id: uuidToBuffer(id),
        org_id: orgId,
        source: 'upload',
        status: 'extracted',
        storage_key: `org/${owner.orgId}/captures/a7-${label}`,
        filename: `a7-${label}.pdf`,
        content_type: 'application/pdf',
        byte_size: 10n,
        created_by_user_id: userId,
      })
      .execute();
    return id;
  };

  const billCaptureId = await extractedCapture('get');
  const dismissibleBillCaptureId = await extractedCapture('dismiss');
  const draftableBillCaptureId = await extractedCapture('draft');

  // A real attachment on the owner's own approved bill, so `getBillAttachment`'s
  // control pass streams actual bytes rather than merely resolving the row.
  // `storageProvider()` is already installed by `useV1App` — the local adapter
  // every route in this file reaches through.
  const attachmentKey = `org/${owner.orgId}/attachments/a7-fixture`;
  await storageProvider().put(attachmentKey, Buffer.from('%PDF-a7-fixture'), 'application/pdf');
  const billAttachmentId = newUuid();
  await db.app
    .insertInto('bill_attachments')
    .values({
      id: uuidToBuffer(billAttachmentId),
      org_id: orgId,
      ap_document_id: uuidToBuffer(targetBillId),
      storage_key: attachmentKey,
      filename: 'a7-fixture.pdf',
      content_type: 'application/pdf',
      byte_size: 15n,
      created_by_user_id: userId,
    })
    .execute();

  return { billCaptureId, dismissibleBillCaptureId, draftableBillCaptureId, billAttachmentId };
}

/** Everything `bankingScene` contributes: M4's half of the scene. */
type BankingScene = Pick<
  Scene,
  | 'bankAccountId'
  | 'bankImportId'
  | 'bankImportMappingId'
  | 'bankRuleId'
  | 'clearedStatementLineId'
  | 'reconciliationSessionId'
  | 'statementLineId'
>;

/**
 * One org's worth of banking, built by an Owner (OB-084).
 *
 * A bank account, a mapping and a rule over HTTP, then the import, its lines, one
 * clearing and an open reconciliation session by direct insert — a statement line is
 * only ever created by an import (OB-078, append-only) and there is no HTTP path to one.
 *
 * Nothing here needs to *succeed* under the operation the matrix runs; it needs to
 * *exist*, so the owner's own call resolves it rather than 404ing. A clearing whose
 * reversal precondition-fails, or a session whose finalise finds a mismatch, still
 * answers the owner with something other than a 404 — which is all `ownerGetsNotFound`
 * asks.
 */
async function bankingScene(
  app: App,
  owner: Session,
  created: Create,
  revenueId: string,
  journalId: string,
): Promise<BankingScene> {
  const bankLedgerId = await createAccount(app, owner, {
    code: '1050',
    name: 'Bank',
    type: 'asset',
    normalBalance: 'debit',
  });

  const bankAccountId = await created('bank-account', '/v1/bank-accounts', {
    accountId: bankLedgerId,
    name: 'Current account',
  });

  const mappingId = await created(
    'bank-mapping',
    `/v1/bank-accounts/${bankAccountId}/import-mappings`,
    {
      name: 'Monthly export',
      definition: {
        hasHeaderRow: true,
        delimiter: ',',
        dateOrder: 'ymd',
        amountConvention: 'signed',
        columns: {
          postedDate: 0,
          description: 1,
          amount: 2,
          debit: null,
          credit: null,
          valueDate: null,
          counterparty: null,
          bankReference: null,
        },
      },
    },
  );

  const ruleId = await created('bank-rule', '/v1/bank-rules', {
    name: 'Coffee is subsistence',
    condition: { description: { mode: 'contains', value: 'COFFEE' } },
    outcome: { accountId: revenueId },
  });

  // The lines, clearing, import and session directly, as the owner's org. `harness.db`
  // is the app-user handle — the identity the routes run as — so a line inserted here is
  // one the app could have written (append-only: insert, never update).
  const db = harness.db;
  const orgId = uuidToBuffer(owner.orgId);
  const userId = uuidToBuffer(owner.userId);
  const bankAccountBytes = uuidToBuffer(bankAccountId);

  const bankImportId = newUuid();
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: uuidToBuffer(bankImportId),
      org_id: orgId,
      bank_account_id: bankAccountBytes,
      format: 'csv',
      filename: 'march.csv',
      file_hash: 'fixture',
      imported_by_user_id: userId,
      status: 'complete',
      lines_read: 2,
      lines_duplicate: 0,
    })
    .execute();

  const statementLineId = newUuid();
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id: uuidToBuffer(statementLineId),
      org_id: orgId,
      bank_account_id: bankAccountBytes,
      import_id: uuidToBuffer(bankImportId),
      posted_date: DOCUMENT_DATE,
      description: 'COFFEE SHOP',
      amount_minor: -450n,
      fingerprint: 'fixture-uncleared',
      occurrence_index: 0,
    })
    .execute();

  const clearedStatementLineId = newUuid();
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id: uuidToBuffer(clearedStatementLineId),
      org_id: orgId,
      bank_account_id: bankAccountBytes,
      import_id: uuidToBuffer(bankImportId),
      posted_date: DOCUMENT_DATE,
      description: 'BANK CHARGE',
      amount_minor: -1000n,
      fingerprint: 'fixture-cleared',
      occurrence_index: 0,
    })
    .execute();
  await db.app
    .insertInto('bank_line_clearings')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: orgId,
      statement_line_id: uuidToBuffer(clearedStatementLineId),
      method: 'post_entry',
      cleared_journal_id: uuidToBuffer(journalId),
      cleared_amount_minor: -1000n,
      difference_amount_minor: 0n,
      created_by_user_id: userId,
    })
    .execute();

  // An open session on this account (D-45), for the get/update/report/finalise/reopen
  // rows. `createReconciliationSession` is not a resource-id surface, so one open session
  // here collides with nothing.
  const reconciliationSessionId = newUuid();
  await db.app
    .insertInto('reconciliation_sessions')
    .values({
      id: uuidToBuffer(reconciliationSessionId),
      org_id: orgId,
      bank_account_id: bankAccountBytes,
      end_date: DOCUMENT_DATE,
      statement_closing_balance_minor: 0n,
      state: 'in_progress',
      created_by_user_id: userId,
    })
    .execute();

  return {
    bankAccountId,
    bankImportMappingId: mappingId,
    bankImportId,
    bankRuleId: ruleId,
    statementLineId,
    clearedStatementLineId,
    reconciliationSessionId,
  };
}

/**
 * The date every M3 fixture is issued and every reversal is dated.
 *
 * The same day the control journal above is posted, which is what puts all of it
 * inside the fiscal year the scene generates. An approval posts on the document's
 * own `issueDate` and a period that did not contain it would refuse the approval
 * with `period_closed` — leaving the void and allocation fixtures unapproved, and
 * an unapproved document answers its *owner* with a `precondition_failed` rather
 * than a `404`, so those rows would pass while asserting nothing.
 */
const DOCUMENT_DATE = '2026-03-31';

/** The four document collections, as they appear in a path. */
type Collection = 'bills' | 'credit-notes' | 'invoices' | 'vendor-credits';

/** Creates one resource through its own route and returns the `id` in the response. */
type Create = (label: string, url: string, payload: Record<string, unknown>) => Promise<string>;

/** Everything `subledgerScene` contributes: M3's half of the scene. */
type SubledgerScene = Pick<
  Scene,
  | 'allocatableCreditNoteId'
  | 'allocatableVendorCreditId'
  | 'allocationId'
  | 'approvableBillId'
  | 'approvableCreditNoteId'
  | 'approvableInvoiceId'
  | 'approvableVendorCreditId'
  | 'discardableBillId'
  | 'discardableCreditNoteId'
  | 'discardableInvoiceId'
  | 'discardableVendorCreditId'
  | 'draftBillId'
  | 'draftCreditNoteId'
  | 'draftInvoiceId'
  | 'draftVendorCreditId'
  | 'partyId'
  | 'paymentId'
  | 'targetBillId'
  | 'targetInvoiceId'
  | 'taxRateId'
  | 'voidableBillId'
  | 'voidableCreditNoteId'
  | 'voidableInvoiceId'
  | 'voidablePaymentId'
  | 'voidableVendorCreditId'
>;

/**
 * One org's AR and AP, built over HTTP by the owner.
 *
 * Over HTTP and not through the services, unlike `permission-matrix.test.ts`'s
 * equivalent: this file's claim is about what the *transport* answers, and a
 * document written past the routes would be this test's own idea of what an
 * approved document is rather than the one `POST …/approve` produces. An approved
 * document is a row plus a journal plus a gapless number, tied together by
 * `chk_ar_documents_approved`, and every `void` and `allocate` row below is judged
 * against one.
 *
 * The control accounts are nominated first, for `DOCUMENT_DATE`'s reason: without
 * them every approval refuses with `receivable_control_account_not_set`.
 */
async function subledgerScene(
  app: App,
  owner: Session,
  created: Create,
  revenueId: string,
): Promise<SubledgerScene> {
  const account = (
    code: string,
    name: string,
    type: string,
    normalBalance: string,
  ): Promise<string> => createAccount(app, owner, { code, name, type, normalBalance });

  const receivableId = await account('1150', 'Accounts receivable', 'asset', 'debit');
  const payableId = await account('2050', 'Accounts payable', 'liability', 'credit');
  const expenseId = await account('5000', 'Office expenses', 'expense', 'debit');
  const bankId = await account('1010', 'Business checking', 'asset', 'debit');
  const taxAccountId = await account('2100', 'VAT payable', 'liability', 'credit');

  const nominated = await app.inject({
    method: 'PATCH',
    url: '/v1/accounting-settings',
    headers: authorizedWrite(owner, 'a7-setup-settings'),
    payload: { receivableControlAccountId: receivableId, payableControlAccountId: payableId },
  });
  if (nominated.statusCode !== 200) {
    throw new Error(`control account setup failed: ${nominated.body}`);
  }

  // One contact carrying both flags: the AR routes refuse a non-customer and the AP
  // routes refuse a non-vendor. Separate from `contactId` above, which is referenced
  // by nothing so that `deleteContact`'s control pass can reach a 204.
  const partyId = await created('party', '/v1/contacts', {
    displayName: 'Subledger Party',
    isCustomer: true,
    isVendor: true,
  });

  // Cited by no document, so `deleteTaxRate`'s control pass reaches a 204 rather
  // than the `precondition_failed` a rate in use earns.
  const taxRateId = await created('tax-rate', '/v1/tax-rates', {
    name: 'VAT 20%',
    percentage: '20',
    accountId: taxAccountId,
  });

  const arBody = {
    contactId: partyId,
    issueDate: DOCUMENT_DATE,
    taxMode: 'exclusive',
    lines: [
      { description: 'Consulting', quantity: '1', unitAmount: '100000', accountId: revenueId },
    ],
  };
  const apLines = [
    { description: 'Paper', quantity: '1', unitAmount: '100000', accountId: expenseId },
  ];
  const billBody = { ...arBody, dueDate: DOCUMENT_DATE, lines: apLines };
  const vendorCreditBody = { ...arBody, lines: apLines };

  const bodies: Readonly<Record<Collection, Record<string, unknown>>> = {
    invoices: { ...arBody, dueDate: DOCUMENT_DATE },
    'credit-notes': arBody,
    bills: billBody,
    'vendor-credits': vendorCreditBody,
  };

  // A counter, not the row's purpose: every draft below needs its own idempotency
  // key, and two identical bodies under one key is a replay rather than a second
  // document — which would silently give two fixtures the same id.
  let sequence = 0;
  const draft = async (collection: Collection): Promise<string> => {
    sequence += 1;
    return created(`${collection}-${String(sequence)}`, `/v1/${collection}`, bodies[collection]);
  };

  const approved = async (collection: Collection): Promise<string> => {
    const id = await draft(collection);
    const response = await app.inject({
      method: 'POST',
      url: `/v1/${collection}/${id}/approve`,
      headers: authorizedWrite(owner, `a7-setup-approve-${collection}-${String(sequence)}`),
    });
    if (response.statusCode !== 200) {
      throw new Error(
        `${collection} approval failed: ${String(response.statusCode)} ${response.body}`,
      );
    }
    return id;
  };

  const targetInvoiceId = await approved('invoices');
  const targetBillId = await approved('bills');

  /**
   * Ten times what any row applies, so the fixture allocation and the three
   * `allocate…` control rows all fit. Over-allocating a *document* is refused (C3),
   * and that refusal is a `precondition_failed` — which would pass this file's
   * control while meaning the row never reached an allocation at all.
   */
  const payment = async (label: string): Promise<string> =>
    created(label, '/v1/payments', {
      direction: 'received',
      contactId: partyId,
      date: DOCUMENT_DATE,
      amount: '1000000',
      accountId: bankId,
    });

  const paymentId = await payment('payment');

  /**
   * The row `deleteAllocation` is judged on, and the only fixture here whose
   * response is not `{ id }`: `POST …/allocations` answers with the whole batch it
   * wrote, because a batch is one decision and returning one member of it would
   * make a client guess which.
   */
  const allocated = await app.inject({
    method: 'POST',
    url: `/v1/payments/${paymentId}/allocations`,
    headers: authorizedWrite(owner, 'a7-setup-allocation'),
    payload: {
      allocations: [{ targetType: 'invoice', targetId: targetInvoiceId, amount: '10000' }],
    },
  });
  if (allocated.statusCode !== 201) {
    throw new Error(`allocation setup failed: ${String(allocated.statusCode)} ${allocated.body}`);
  }
  const allocationId = allocated.json<{ allocations: { id: string }[] }>().allocations[0]?.id;
  if (allocationId === undefined) throw new Error('allocation setup wrote no rows');

  return {
    partyId,
    taxRateId,
    allocationId,
    targetInvoiceId,
    draftInvoiceId: await draft('invoices'),
    approvableInvoiceId: await draft('invoices'),
    voidableInvoiceId: await approved('invoices'),
    discardableInvoiceId: await draft('invoices'),
    allocatableCreditNoteId: await approved('credit-notes'),
    draftCreditNoteId: await draft('credit-notes'),
    approvableCreditNoteId: await draft('credit-notes'),
    voidableCreditNoteId: await approved('credit-notes'),
    discardableCreditNoteId: await draft('credit-notes'),
    targetBillId,
    draftBillId: await draft('bills'),
    approvableBillId: await draft('bills'),
    voidableBillId: await approved('bills'),
    discardableBillId: await draft('bills'),
    allocatableVendorCreditId: await approved('vendor-credits'),
    draftVendorCreditId: await draft('vendor-credits'),
    approvableVendorCreditId: await draft('vendor-credits'),
    voidableVendorCreditId: await approved('vendor-credits'),
    discardableVendorCreditId: await draft('vendor-credits'),
    paymentId,
    voidablePaymentId: await payment('payment-2'),
  };
}

/**
 * One row of the matrix: an operation, and how a resource id reaches it.
 *
 * Keyed by `operationId` rather than by method and path so the coverage check below can
 * compare this table against the published OpenAPI document directly — the same
 * identifier the generated client (OB-024) names its methods after.
 */
interface Surface {
  readonly operationId: string;
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `%s` is replaced by the id under test. */
  readonly path: string;
  readonly id: (scene: Scene) => string;
  /**
   * A body, given the id under test. Absent for GET and DELETE.
   *
   * The scene is passed as well as the id because M3's three `allocate…` rows need
   * a *second* id in the body — the invoice or bill being settled — and it has to
   * be the owner's real one in both passes. If the stranger's request carried an
   * unresolvable target it could fail on the target rather than on the source, and
   * the row would then be asserting that a nonexistent invoice 404s rather than
   * that another org's payment does.
   */
  readonly payload?: (id: string, scene: Scene) => Record<string, unknown>;
  /**
   * The second `%s` a two-id path needs, resolved to `%o` — only `getBillAttachment`
   * (`/v1/bills/{billId}/attachments/{attachmentId}`). The id under test is the
   * attachment; the bill stays the owner's real one in every pass, which still
   * proves the whole route across orgs: `selectAttachment` scopes both segments by
   * `org_id` in one query, so a stranger resolves neither regardless of which one
   * is theirs to probe — the same reasoning `allocate…`'s fixed target gives, one
   * path segment over rather than one body field.
   */
  readonly otherId?: (scene: Scene) => string;
  /**
   * Overrides `SEALED` for a row whose "does not leak existence" shape is not a
   * `404` pair — only `revokeConnectedApp`, whose own no-op design answers `204`
   * both times. Absent means `SEALED`, every other row's claim.
   */
  readonly expected?: Verdict;
}

/**
 * `revokeConnectedApp`'s own verdict, `SEALED`'s claim one status code over: the
 * stranger's answer is byte-identical whether the public client id names another
 * org's client or nothing at all, because the operation is a no-op for either —
 * `oauth.service.ts`'s own header states it plainly ("a client never consented to,
 * or already revoked, is a no-op rather than a `not_found`"), for A7's reason
 * exactly: reporting the existence of *someone else's* consent is what a `404`
 * here would do.
 */
const NO_OP: Verdict = {
  crossOrg: 204,
  nonexistent: 204,
  identicalBody: true,
  identicalContentType: true,
  echoesId: false,
  ownerGetsNotFound: false,
};

/**
 * Ordered so the control pass — the owner calling each of these on their own
 * resources — can run straight through without a row invalidating the next: rename,
 * deactivate, and reactivate all leave the account in place, and `deleteAccount` comes
 * after them (and is refused, because the account carries postings, which is still not
 * a `404`). The leak pass is order-independent, since every row answers the same way.
 *
 * OB-045's rows inherit that constraint and two of them make it sharp: `deleteContact`
 * succeeds, so it is the last row naming a contact, and posting a draft deletes it
 * (D-19), so `postDraft` and `discardDraft` name two different drafts. A row that
 * destroyed something a later row reads would answer `404` for the *owner*, which
 * `ownerGetsNotFound` turns into a failure rather than a silently vacuous pass.
 */
const SURFACES: readonly Surface[] = [
  { operationId: 'getAccount', method: 'GET', path: '/v1/accounts/%s', id: (s) => s.accountId },
  {
    operationId: 'updateAccount',
    method: 'PATCH',
    path: '/v1/accounts/%s',
    id: (s) => s.accountId,
    payload: () => ({ name: 'Renamed' }),
  },
  {
    operationId: 'deactivateAccount',
    method: 'POST',
    path: '/v1/accounts/%s/deactivate',
    id: (s) => s.accountId,
  },
  {
    operationId: 'reactivateAccount',
    method: 'POST',
    path: '/v1/accounts/%s/reactivate',
    id: (s) => s.accountId,
  },
  {
    operationId: 'deleteAccount',
    method: 'DELETE',
    path: '/v1/accounts/%s',
    id: (s) => s.accountId,
  },
  {
    operationId: 'closeFiscalPeriod',
    method: 'POST',
    path: '/v1/fiscal-periods/%s/close',
    id: (s) => s.periodId,
  },
  {
    operationId: 'reopenFiscalPeriod',
    method: 'POST',
    path: '/v1/fiscal-periods/%s/reopen',
    id: (s) => s.periodId,
  },
  {
    operationId: 'reverseJournal',
    method: 'POST',
    path: '/v1/journals/%s/reverse',
    id: (s) => s.journalId,
    payload: () => ({ date: '2026-04-30' }),
  },
  {
    operationId: 'getContact',
    method: 'GET',
    path: '/v1/contacts/%s',
    id: (s) => s.contactId,
  },
  {
    operationId: 'updateContact',
    method: 'PATCH',
    path: '/v1/contacts/%s',
    id: (s) => s.contactId,
    payload: () => ({ displayName: 'Renamed' }),
  },
  {
    operationId: 'deactivateContact',
    method: 'POST',
    path: '/v1/contacts/%s/deactivate',
    id: (s) => s.contactId,
  },
  {
    operationId: 'reactivateContact',
    method: 'POST',
    path: '/v1/contacts/%s/reactivate',
    id: (s) => s.contactId,
  },
  // Last of the contact rows: the control pass succeeds here and the row is gone.
  {
    operationId: 'deleteContact',
    method: 'DELETE',
    path: '/v1/contacts/%s',
    id: (s) => s.contactId,
  },
  // Phase 4: the recurring template and dunning policy id-addressed routes.
  {
    operationId: 'getRecurringInvoiceTemplate',
    method: 'GET',
    path: '/v1/recurring-invoices/%s',
    id: (s) => s.recurringTemplateId,
  },
  {
    operationId: 'updateRecurringInvoiceTemplate',
    method: 'PATCH',
    path: '/v1/recurring-invoices/%s',
    id: (s) => s.recurringTemplateId,
    payload: () => ({ name: 'Renamed' }),
  },
  {
    operationId: 'deactivateRecurringInvoiceTemplate',
    method: 'POST',
    path: '/v1/recurring-invoices/%s/deactivate',
    id: (s) => s.recurringTemplateId,
  },
  {
    operationId: 'getDunningPolicy',
    method: 'GET',
    path: '/v1/dunning-policies/%s',
    id: (s) => s.dunningPolicyId,
  },
  {
    operationId: 'updateDunningPolicy',
    method: 'PATCH',
    path: '/v1/dunning-policies/%s',
    id: (s) => s.dunningPolicyId,
    payload: () => ({ name: 'Renamed' }),
  },
  {
    operationId: 'deactivateDunningPolicy',
    method: 'POST',
    path: '/v1/dunning-policies/%s/deactivate',
    id: (s) => s.dunningPolicyId,
  },
  {
    operationId: 'getDimension',
    method: 'GET',
    path: '/v1/dimensions/%s',
    id: (s) => s.dimensionId,
  },
  {
    operationId: 'updateDimension',
    method: 'PATCH',
    path: '/v1/dimensions/%s',
    id: (s) => s.dimensionId,
    payload: () => ({ name: 'Cost centre' }),
  },
  {
    operationId: 'listDimensionValues',
    method: 'GET',
    path: '/v1/dimensions/%s/values',
    id: (s) => s.dimensionId,
  },
  {
    operationId: 'createDimensionValue',
    method: 'POST',
    path: '/v1/dimensions/%s/values',
    id: (s) => s.dimensionId,
    payload: () => ({ code: 'OPS', name: 'Operations' }),
  },
  {
    operationId: 'getDimensionValue',
    method: 'GET',
    path: '/v1/dimension-values/%s',
    id: (s) => s.dimensionValueId,
  },
  {
    operationId: 'updateDimensionValue',
    method: 'PATCH',
    path: '/v1/dimension-values/%s',
    id: (s) => s.dimensionValueId,
    payload: () => ({ name: 'Sales team' }),
  },
  {
    operationId: 'archiveDimensionValue',
    method: 'POST',
    path: '/v1/dimension-values/%s/archive',
    id: (s) => s.dimensionValueId,
  },
  {
    operationId: 'unarchiveDimensionValue',
    method: 'POST',
    path: '/v1/dimension-values/%s/unarchive',
    id: (s) => s.dimensionValueId,
  },
  {
    operationId: 'deleteDimensionValue',
    method: 'DELETE',
    path: '/v1/dimension-values/%s',
    id: (s) => s.dimensionValueId,
  },
  {
    operationId: 'archiveDimension',
    method: 'POST',
    path: '/v1/dimensions/%s/archive',
    id: (s) => s.dimensionId,
  },
  {
    operationId: 'unarchiveDimension',
    method: 'POST',
    path: '/v1/dimensions/%s/unarchive',
    id: (s) => s.dimensionId,
  },
  /**
   * The owner's own call here is a `precondition_failed`, not a success: the row
   * above created a second value on this axis. That is still not a `404`, which is
   * all this matrix asks — the control exists to prove the path is real, not that
   * the operation is applicable.
   */
  {
    operationId: 'deleteDimension',
    method: 'DELETE',
    path: '/v1/dimensions/%s',
    id: (s) => s.dimensionId,
  },
  /**
   * The two rows whose id is not a uuid. `journal_lines.id` is a `BIGINT` on the
   * wire, so the nonexistent id these are asked with is *malformed* rather than
   * merely absent — and the answer has to be the same `404`, or the shape of an id
   * becomes an oracle of its own.
   */
  {
    operationId: 'getJournalLineDimensions',
    method: 'GET',
    path: '/v1/journal-lines/%s/dimensions',
    id: (s) => s.journalLineId,
  },
  {
    operationId: 'setJournalLineDimensions',
    method: 'PUT',
    path: '/v1/journal-lines/%s/dimensions',
    id: (s) => s.journalLineId,
    payload: () => ({ valueIds: [] }),
  },
  {
    operationId: 'getDraft',
    method: 'GET',
    path: '/v1/journal-drafts/%s',
    id: (s) => s.draftId,
  },
  {
    operationId: 'updateDraft',
    method: 'PATCH',
    path: '/v1/journal-drafts/%s',
    id: (s) => s.draftId,
    payload: () => ({ memo: 'Edited' }),
  },
  // Consumes `draftId`; `discardDraft` below uses the second draft for that reason.
  {
    operationId: 'postDraft',
    method: 'POST',
    path: '/v1/journal-drafts/%s/post',
    id: (s) => s.draftId,
  },
  {
    operationId: 'discardDraft',
    method: 'DELETE',
    path: '/v1/journal-drafts/%s',
    id: (s) => s.discardableDraftId,
  },
  /**
   * A membership is addressed by the *user*, and the two rows below are the surface
   * that would otherwise enumerate the users of every tenant. The owner's own calls
   * are a no-op re-role and a refused self-removal (the last-Owner rule) — neither
   * is a `404`.
   */
  {
    operationId: 'changeMemberRole',
    method: 'PATCH',
    path: '/v1/members/%s',
    id: (s) => s.owner.userId,
    payload: () => ({ roleId: OWNER_ROLE_ID }),
  },
  {
    operationId: 'removeMember',
    method: 'DELETE',
    path: '/v1/members/%s',
    id: (s) => s.owner.userId,
  },
  {
    operationId: 'revokeInvite',
    method: 'POST',
    path: '/v1/invites/%s/revoke',
    id: (s) => s.inviteId,
  },
  {
    /**
     * The one row whose id travels in the body rather than the path, which is why the
     * coverage check below names it explicitly: a body-carried id is no less an
     * existence oracle, and this is the surface an org switcher would use to walk every
     * tenant in the system.
     */
    operationId: 'switchActiveOrg',
    method: 'POST',
    path: '/v1/orgs/active',
    id: (s) => s.owner.orgId,
    payload: (id) => ({ orgId: id }),
  },

  // ---------------------------------------------------------------------------
  // M3 (OB-067). Thirty-two rows, and the reason there are five per document kind
  // rather than one is `ownerGetsNotFound`: approve, void and discard each move a
  // document somewhere a later row could not read it from.
  //
  // Ordered so the control pass runs straight through. Within a kind: read, edit,
  // approve, void, allocate, discard — discard last because it is the one that
  // removes the row, and allocate after approve because only an approved document
  // has anything to apply.
  //
  // Every one of these is a surface a competitor's *customer list* is behind, which
  // is what makes M3 the milestone where a leak stops being abstract: an oracle on
  // `/v1/invoices/{id}` tells an attacker that a given invoice id exists, and the
  // ids on this surface are handed to the people who receive the documents.
  // ---------------------------------------------------------------------------

  {
    operationId: 'getInvoice',
    method: 'GET',
    path: '/v1/invoices/%s',
    id: (s) => s.targetInvoiceId,
  },
  {
    operationId: 'updateInvoice',
    method: 'PATCH',
    path: '/v1/invoices/%s',
    id: (s) => s.draftInvoiceId,
    payload: () => ({ memo: 'Edited' }),
  },
  {
    operationId: 'approveInvoice',
    method: 'POST',
    path: '/v1/invoices/%s/approve',
    id: (s) => s.approvableInvoiceId,
  },
  {
    operationId: 'voidInvoice',
    method: 'POST',
    path: '/v1/invoices/%s/void',
    id: (s) => s.voidableInvoiceId,
    payload: () => ({ date: DOCUMENT_DATE }),
  },
  {
    // INV (Phase 1): sending another org's invoice is the same 404 as reading it. The
    // owner's control pass over its own approved invoice is not a `404` — it reaches the
    // send (or a precondition past the gate), which is all this matrix asks.
    operationId: 'sendInvoice',
    method: 'POST',
    path: '/v1/invoices/%s/send',
    id: (s) => s.targetInvoiceId,
    payload: () => ({}),
  },
  // Last of the invoice rows: the control pass reaches a 204 and the draft is gone.
  {
    operationId: 'discardInvoice',
    method: 'DELETE',
    path: '/v1/invoices/%s',
    id: (s) => s.discardableInvoiceId,
  },
  {
    operationId: 'getCreditNote',
    method: 'GET',
    path: '/v1/credit-notes/%s',
    id: (s) => s.allocatableCreditNoteId,
  },
  {
    operationId: 'updateCreditNote',
    method: 'PATCH',
    path: '/v1/credit-notes/%s',
    id: (s) => s.draftCreditNoteId,
    payload: () => ({ memo: 'Edited' }),
  },
  {
    operationId: 'approveCreditNote',
    method: 'POST',
    path: '/v1/credit-notes/%s/approve',
    id: (s) => s.approvableCreditNoteId,
  },
  {
    operationId: 'voidCreditNote',
    method: 'POST',
    path: '/v1/credit-notes/%s/void',
    id: (s) => s.voidableCreditNoteId,
    payload: () => ({ date: DOCUMENT_DATE }),
  },
  /**
   * The first of the three allocation rows, and the shape they share: the id under
   * test is the *source* in the path, and the target in the body is the owner's
   * invoice in every pass. So a `404` here is a statement about the credit note,
   * which is the id an outsider would be probing.
   */
  {
    operationId: 'allocateCreditNote',
    method: 'POST',
    path: '/v1/credit-notes/%s/allocations',
    id: (s) => s.allocatableCreditNoteId,
    payload: (_id, s) => ({
      allocations: [{ targetType: 'invoice', targetId: s.targetInvoiceId, amount: '10000' }],
    }),
  },
  {
    operationId: 'discardCreditNote',
    method: 'DELETE',
    path: '/v1/credit-notes/%s',
    id: (s) => s.discardableCreditNoteId,
  },
  {
    operationId: 'getBill',
    method: 'GET',
    path: '/v1/bills/%s',
    id: (s) => s.targetBillId,
  },
  {
    operationId: 'updateBill',
    method: 'PATCH',
    path: '/v1/bills/%s',
    id: (s) => s.draftBillId,
    payload: () => ({ memo: 'Edited' }),
  },
  {
    operationId: 'approveBill',
    method: 'POST',
    path: '/v1/bills/%s/approve',
    id: (s) => s.approvableBillId,
  },
  {
    operationId: 'voidBill',
    method: 'POST',
    path: '/v1/bills/%s/void',
    id: (s) => s.voidableBillId,
    payload: () => ({ date: DOCUMENT_DATE }),
  },
  {
    operationId: 'discardBill',
    method: 'DELETE',
    path: '/v1/bills/%s',
    id: (s) => s.discardableBillId,
  },
  {
    operationId: 'getVendorCredit',
    method: 'GET',
    path: '/v1/vendor-credits/%s',
    id: (s) => s.allocatableVendorCreditId,
  },
  {
    operationId: 'updateVendorCredit',
    method: 'PATCH',
    path: '/v1/vendor-credits/%s',
    id: (s) => s.draftVendorCreditId,
    payload: () => ({ memo: 'Edited' }),
  },
  {
    operationId: 'approveVendorCredit',
    method: 'POST',
    path: '/v1/vendor-credits/%s/approve',
    id: (s) => s.approvableVendorCreditId,
  },
  {
    operationId: 'voidVendorCredit',
    method: 'POST',
    path: '/v1/vendor-credits/%s/void',
    id: (s) => s.voidableVendorCreditId,
    payload: () => ({ date: DOCUMENT_DATE }),
  },
  {
    operationId: 'allocateVendorCredit',
    method: 'POST',
    path: '/v1/vendor-credits/%s/allocations',
    id: (s) => s.allocatableVendorCreditId,
    payload: (_id, s) => ({
      allocations: [{ targetType: 'bill', targetId: s.targetBillId, amount: '10000' }],
    }),
  },
  {
    operationId: 'discardVendorCredit',
    method: 'DELETE',
    path: '/v1/vendor-credits/%s',
    id: (s) => s.discardableVendorCreditId,
  },
  {
    operationId: 'getPayment',
    method: 'GET',
    path: '/v1/payments/%s',
    id: (s) => s.paymentId,
  },
  {
    operationId: 'updatePayment',
    method: 'PATCH',
    path: '/v1/payments/%s',
    id: (s) => s.paymentId,
    payload: () => ({ memo: 'Edited' }),
  },
  {
    operationId: 'allocatePayment',
    method: 'POST',
    path: '/v1/payments/%s/allocations',
    id: (s) => s.paymentId,
    payload: (_id, s) => ({
      allocations: [{ targetType: 'invoice', targetId: s.targetInvoiceId, amount: '10000' }],
    }),
  },
  /**
   * Its own payment, because voiding one deletes the allocations it made — and the
   * row above and the fixture allocation `deleteAllocation` names are both on
   * `paymentId`.
   */
  {
    operationId: 'voidPayment',
    method: 'POST',
    path: '/v1/payments/%s/void',
    id: (s) => s.voidablePaymentId,
    payload: () => ({ date: DOCUMENT_DATE }),
  },
  {
    operationId: 'deleteAllocation',
    method: 'DELETE',
    path: '/v1/allocations/%s',
    id: (s) => s.allocationId,
  },
  {
    operationId: 'getTaxRate',
    method: 'GET',
    path: '/v1/tax-rates/%s',
    id: (s) => s.taxRateId,
  },
  {
    operationId: 'updateTaxRate',
    method: 'PATCH',
    path: '/v1/tax-rates/%s',
    id: (s) => s.taxRateId,
    payload: () => ({ name: 'VAT (standard)' }),
  },
  {
    operationId: 'archiveTaxRate',
    method: 'POST',
    path: '/v1/tax-rates/%s/archive',
    id: (s) => s.taxRateId,
  },
  {
    operationId: 'unarchiveTaxRate',
    method: 'POST',
    path: '/v1/tax-rates/%s/unarchive',
    id: (s) => s.taxRateId,
  },
  // Last row in the table: the control pass deletes the rate, which is only
  // possible because no document cites it.
  {
    operationId: 'deleteTaxRate',
    method: 'DELETE',
    path: '/v1/tax-rates/%s',
    id: (s) => s.taxRateId,
  },

  // ---------------------------------------------------------------------------
  // M4 (OB-084). Every banking operation whose id travels in the *path* — the ones
  // that assert their resource and so answer a cross-org id with a 404. The listing
  // reads that filter rather than assert (`GET /v1/import-mappings?bankAccountId=`,
  // `GET /v1/statement-lines`, …) carry their ids in the *query*, so an unknown one is
  // an empty page, not a 404; those are `cross-org-references.test.ts`'s (B11), not
  // here. For the mutating rows a precondition failure is fine — a `412` is not a
  // `404`, so `ownerGetsNotFound` stays false and the fixture need only exist.
  // ---------------------------------------------------------------------------

  {
    operationId: 'getBankAccount',
    method: 'GET',
    path: '/v1/bank-accounts/%s',
    id: (s) => s.bankAccountId,
  },
  {
    operationId: 'updateBankAccount',
    method: 'PATCH',
    path: '/v1/bank-accounts/%s',
    id: (s) => s.bankAccountId,
    payload: () => ({ name: 'Renamed' }),
  },
  // Deactivate before reactivate, and both judged only on not being a `404`: the owner's
  // own `bankAccountId` carries an open session (the scene inserts one), so the control
  // pass's deactivate is a `412` rather than a state change, which leaves the account in
  // place for reactivate and the rows after it — exactly what the ordering note requires.
  {
    operationId: 'deactivateBankAccount',
    method: 'POST',
    path: '/v1/bank-accounts/%s/deactivate',
    id: (s) => s.bankAccountId,
  },
  {
    operationId: 'reactivateBankAccount',
    method: 'POST',
    path: '/v1/bank-accounts/%s/reactivate',
    id: (s) => s.bankAccountId,
  },
  {
    operationId: 'saveBankImportMapping',
    method: 'POST',
    path: '/v1/bank-accounts/%s/import-mappings',
    id: (s) => s.bankAccountId,
    payload: () => ({
      name: 'Another export',
      definition: {
        hasHeaderRow: true,
        delimiter: ',',
        dateOrder: 'ymd',
        amountConvention: 'signed',
        columns: {
          postedDate: 0,
          description: 1,
          amount: 2,
          debit: null,
          credit: null,
          valueDate: null,
          counterparty: null,
          bankReference: null,
        },
      },
    }),
  },
  {
    operationId: 'getBankImportMapping',
    method: 'GET',
    path: '/v1/import-mappings/%s',
    id: (s) => s.bankImportMappingId,
  },
  {
    operationId: 'getBankStatementImport',
    method: 'GET',
    path: '/v1/bank-statement-imports/%s',
    id: (s) => s.bankImportId,
  },
  {
    operationId: 'getStatementLine',
    method: 'GET',
    path: '/v1/statement-lines/%s',
    id: (s) => s.statementLineId,
  },
  /**
   * The id under test is the *line* in the path; the account it codes to is the owner's
   * own in both passes, so a `404` here is a statement about the line, which is the id
   * an outsider would be probing. Clearing the line posts a journal — but only after
   * the line resolves, so a cross-org line 404s before anything is posted.
   */
  {
    operationId: 'clearBankStatementLine',
    method: 'POST',
    path: '/v1/statement-lines/%s/clearing',
    id: (s) => s.statementLineId,
    payload: (_id, s) => ({ method: 'post_entry', accountId: s.accountId }),
  },
  {
    operationId: 'removeBankLineClearing',
    method: 'DELETE',
    path: '/v1/statement-lines/%s/clearing',
    id: (s) => s.clearedStatementLineId,
    payload: () => ({ date: DOCUMENT_DATE }),
  },
  {
    operationId: 'getBankRule',
    method: 'GET',
    path: '/v1/bank-rules/%s',
    id: (s) => s.bankRuleId,
  },
  {
    operationId: 'updateBankRule',
    method: 'PATCH',
    path: '/v1/bank-rules/%s',
    id: (s) => s.bankRuleId,
    payload: () => ({ isActive: false }),
  },
  {
    operationId: 'getReconciliationSession',
    method: 'GET',
    path: '/v1/reconciliation-sessions/%s',
    id: (s) => s.reconciliationSessionId,
  },
  {
    operationId: 'updateReconciliationSession',
    method: 'PATCH',
    path: '/v1/reconciliation-sessions/%s',
    id: (s) => s.reconciliationSessionId,
    payload: () => ({ statementClosingBalance: '0' }),
  },
  {
    operationId: 'getReconciliationReport',
    method: 'GET',
    path: '/v1/reconciliation-sessions/%s/report',
    id: (s) => s.reconciliationSessionId,
  },
  // Finalise then reopen, on the one session: finalising it makes the reopen's control
  // pass find a finalised session to reopen. Both are still judged only on not being a
  // 404, so the order is for realism, not correctness.
  {
    operationId: 'finaliseReconciliationSession',
    method: 'POST',
    path: '/v1/reconciliation-sessions/%s/finalise',
    id: (s) => s.reconciliationSessionId,
  },
  {
    operationId: 'reopenReconciliationSession',
    method: 'POST',
    path: '/v1/reconciliation-sessions/%s/reopen',
    id: (s) => s.reconciliationSessionId,
    payload: () => ({ reason: 'A cleared line was miscoded and needs correcting.' }),
  },

  // ---------------------------------------------------------------------------
  // OCR bill capture (initiative O, OB-186…190). `receiveInboundBill`'s `{token}` is
  // the auth token itself, not a resource id — it is excluded below with
  // `getPublicInvoiceView`/`getPublicInvoicePdf`'s reasoning, not given a row here.
  // ---------------------------------------------------------------------------

  {
    operationId: 'getBillCapture',
    method: 'GET',
    path: '/v1/bills/captures/%s',
    id: (s) => s.billCaptureId,
  },
  {
    operationId: 'dismissBillCapture',
    method: 'POST',
    path: '/v1/bills/captures/%s/dismiss',
    id: (s) => s.dismissibleBillCaptureId,
  },
  {
    // `contactId` is the owner's real `partyId` in every pass, `allocate…`'s reason:
    // a stranger's request 404s on the capture id before the body is ever resolved,
    // so an unresolvable contact in the body would test the wrong thing.
    operationId: 'createDraftFromBillCapture',
    method: 'POST',
    path: '/v1/bills/captures/%s/draft',
    id: (s) => s.draftableBillCaptureId,
    payload: (_id, s) => ({
      contactId: s.partyId,
      issueDate: DOCUMENT_DATE,
      dueDate: DOCUMENT_DATE,
      taxMode: 'exclusive',
      lines: [
        { description: 'Paper', quantity: '1', unitAmount: '100000', accountId: s.accountId },
      ],
    }),
  },
  {
    // The id under test is the attachment; see `Surface.otherId`'s header for why a
    // fixed, owner-real bill id still proves the whole route across orgs.
    operationId: 'getBillAttachment',
    method: 'GET',
    path: '/v1/bills/%o/attachments/%s',
    id: (s) => s.billAttachmentId,
    otherId: (s) => s.targetBillId,
  },

  // ---------------------------------------------------------------------------
  // M5 (OB-097…104): the platform surface's own id-addressed operations — a key,
  // an OAuth client, a client's public id, and the two proposal-review actions.
  // ---------------------------------------------------------------------------

  {
    operationId: 'revokeApiKey',
    method: 'POST',
    path: '/v1/api-keys/%s/revoke',
    id: (s) => s.apiKeyId,
  },
  {
    operationId: 'deactivateOAuthClient',
    method: 'POST',
    path: '/v1/oauth-clients/%s/deactivate',
    id: (s) => s.oauthClientId,
  },
  {
    // `NO_OP`, not `SEALED`: see the constant's own comment. The id under test is
    // the public `client_id`, not the REST id `deactivateOAuthClient` above uses —
    // `oauth-clients.ts`'s file header states why the two differ.
    operationId: 'revokeConnectedApp',
    method: 'POST',
    path: '/v1/connected-apps/%s/revoke',
    id: (s) => s.oauthClientPublicId,
    expected: NO_OP,
  },
  {
    operationId: 'approveProposal',
    method: 'POST',
    path: '/v1/agent-proposals/%s/approve',
    id: (s) => s.approvableProposalId,
  },
  {
    // Its own draft, `discardDraft`'s reason above: `approveProposal` consumes
    // `approvableProposalId` by posting it, so a shared draft would leave this row
    // 404ing for the *owner* too.
    operationId: 'rejectProposal',
    method: 'POST',
    path: '/v1/agent-proposals/%s/reject',
    id: (s) => s.rejectableProposalId,
  },

  // ---------------------------------------------------------------------------
  // Payment integration (OB-150): the three operations whose id travels in the
  // path. `connectProcessor`/`listProcessorConnections` carry no resource id and
  // are not surfaces here, the same reason `createReconciliationSession` above is
  // not one.
  // ---------------------------------------------------------------------------

  {
    operationId: 'getProcessorConnection',
    method: 'GET',
    path: '/v1/processing/connections/%s',
    id: (s) => s.processorConnectionId,
  },
  // Deactivate before reactivate, on the one connection: both are judged only on
  // not being a `404`, `deactivateBankAccount`/`reactivateBankAccount`'s reason above.
  {
    operationId: 'deactivateProcessorConnection',
    method: 'POST',
    path: '/v1/processing/connections/%s/deactivate',
    id: (s) => s.processorConnectionId,
  },
  {
    operationId: 'reactivateProcessorConnection',
    method: 'POST',
    path: '/v1/processing/connections/%s/reactivate',
    id: (s) => s.processorConnectionId,
  },
];

/** What every row must report. Deviations are the leak. */
interface Verdict {
  readonly crossOrg: number;
  readonly nonexistent: number;
  readonly identicalBody: boolean;
  readonly identicalContentType: boolean;
  readonly echoesId: boolean;
  /**
   * The control, and it is not optional: a row whose path is misspelled answers Fastify's
   * own `404` to both requests, with identical bodies and no echoed id, and passes every
   * other field in this record while testing nothing. Asserting that the *owner* does not
   * get a `404` is what makes the stranger's `404` a statement about ownership.
   */
  readonly ownerGetsNotFound: boolean;
}

const SEALED: Verdict = {
  crossOrg: 404,
  nonexistent: 404,
  identicalBody: true,
  identicalContentType: true,
  echoesId: false,
  ownerGetsNotFound: false,
};

async function ask(
  app: App,
  session: Awaited<ReturnType<typeof registerUser>>,
  surface: Surface,
  id: string,
  key: string,
  built: Scene,
): Promise<LightMyRequestResponse> {
  const path =
    surface.otherId === undefined
      ? surface.path.replace('%s', id)
      : surface.path.replace('%s', id).replace('%o', surface.otherId(built));

  return app.inject({
    method: surface.method,
    url: path,
    // Every write here is idempotency-guarded, and a distinct key per request is
    // required: the same key with a different body is an `idempotency_key_conflict`,
    // which would replace the answer under test with a different one.
    headers: authorizedWrite(session, key),
    ...(surface.payload === undefined ? {} : { payload: surface.payload(id, built) }),
  });
}

describe('A7 across every surface that takes a resource id', () => {
  it('answers a cross-org id exactly as it answers one that never existed', async () => {
    const app = harness.app();
    const built = await scene(app);

    const leaks = new Map<string, Omit<Verdict, 'ownerGetsNotFound'>>();
    for (const surface of SURFACES) {
      const real = surface.id(built);
      const crossOrg = await ask(
        app,
        built.stranger,
        surface,
        real,
        `a7-cross-${surface.operationId}`,
        built,
      );
      const nonexistent = await ask(
        app,
        built.stranger,
        surface,
        NOWHERE,
        `a7-none-${surface.operationId}`,
        built,
      );

      leaks.set(surface.operationId, {
        crossOrg: crossOrg.statusCode,
        nonexistent: nonexistent.statusCode,
        identicalBody: crossOrg.body === nonexistent.body,
        identicalContentType:
          crossOrg.headers['content-type'] === nonexistent.headers['content-type'],
        echoesId: crossOrg.body.includes(real),
      });
    }

    // The control pass, last because it mutates the owner's own data. Run after the
    // leak pass so nothing it changes can influence the answers above.
    const verdicts: Record<string, Verdict> = {};
    for (const surface of SURFACES) {
      const owned = await ask(
        app,
        built.owner,
        surface,
        surface.id(built),
        `a7-owner-${surface.operationId}`,
        built,
      );
      verdicts[surface.operationId] = {
        ...(leaks.get(surface.operationId) as Omit<Verdict, 'ownerGetsNotFound'>),
        ownerGetsNotFound: owned.statusCode === 404,
      };
    }

    // One assertion over the whole matrix: a failure names the operation that leaks and
    // shows that the others do not, which is the information needed to fix it.
    // `surface.expected` overrides `SEALED` for the one row (`revokeConnectedApp`)
    // whose own no-op design answers something other than `404`.
    expect(verdicts).toEqual(
      Object.fromEntries(
        SURFACES.map((surface) => [surface.operationId, surface.expected ?? SEALED]),
      ),
    );
  });

  /**
   * The converse. Without it the matrix above is only as complete as whoever last
   * added a route remembered to make it.
   *
   * Compared against the *generated* OpenAPI document rather than a hand-kept list,
   * because that document is derived from the registered routes — so a new
   * `/v1/{thing}/{id}` route appears here the moment it is registered, and this test
   * names it as uncovered before it can ship as a leak.
   */
  it('covers every operation that takes a resource id', async () => {
    const document = JSON.parse(await generateOpenApiDocument(harness.app())) as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };

    // The hosted invoice page's two routes are path-templated on `{token}`, but a
    // capability token is not an org-scoped resource id: it carries no org context and
    // is the whole authorization (D-74), so A7's cross-org 404 does not apply — a forged
    // or foreign token is already indistinguishable from an unissued one, proven in
    // `test/delivery`. They are excluded here rather than added to `SURFACES` with an
    // org axis they do not have.
    //
    // `receiveInboundBill`'s `{token}` is the same shape one milestone over: the org's
    // inbound-capture mailbox address, resolved by `resolveOrgIdForInboundToken` before
    // any org context exists, never a resource id inside one.
    //
    // Payment integration (OB-150) adds two more, one of each kind. `createPublicPayLink`'s
    // `{token}` is the identical hosted-invoice capability token the pair above carry —
    // `public-pay-link.ts`'s own header says so. `receiveProcessorWebhook`'s `{connectionId}`
    // is not a secret (that file's header is explicit: the delivery's own signature is the
    // authorization, not this path segment) but carries no caller session either — there is
    // no stranger-versus-owner axis to run the SURFACES matrix over, so it is excluded here
    // for the same practical reason as the token-gated three, not because it is one of them.
    const tokenGatedPublicOperations = new Set([
      'getPublicInvoiceView',
      'getPublicInvoicePdf',
      'receiveInboundBill',
      'createPublicPayLink',
      'receiveProcessorWebhook',
    ]);
    const templated = Object.entries(document.paths)
      .filter(([path]) => path.includes('{'))
      .flatMap(([, item]) => Object.values(item).map((operation) => operation.operationId))
      .filter((operationId) => !tokenGatedPublicOperations.has(operationId))
      .sort();

    const covered = SURFACES.map((surface) => surface.operationId).sort();

    // `switchActiveOrg` is in the matrix but not in `templated`: its id is in the body,
    // so no path template names it. Subtracted here rather than special-cased in the
    // table, so the equality below stays a plain statement about path-templated
    // operations.
    expect(covered.filter((operationId) => operationId !== 'switchActiveOrg')).toEqual(templated);
    expect(covered).toContain('switchActiveOrg');
  });
});

/**
 * The same claim one layer down, for the reads that have no route.
 *
 * `getPeriod` is exported from the periods module and is not reachable over HTTP in M1
 * — journal and period *reads* are M2's general-ledger surface — so the matrix above
 * cannot see it, and it is exactly the kind of function a new route will be built on.
 * `getAccount`, `reverseJournal`, and `resolveOrgMembership` are included even though
 * two of them are already covered by `test/ledger/posting.test.ts`, because the value
 * of a matrix is that it is complete: a fifth resource type with no row is obvious
 * here and would not be obvious spread across four files.
 *
 * Compared through `toWireError`, which is what decides the response body for every
 * transport — so equality here is equality on the wire, for HTTP today and for MCP in
 * M5.
 */
describe('A7 at the service layer, including the reads with no route', () => {
  it('gives cross-org and nonexistent ids the same wire error', async () => {
    const app = harness.app();
    const built = await scene(app);
    const ctx = contextFor(built.stranger.orgId, OWNER_ROLE_ID, built.stranger.userId);

    const reads: readonly {
      readonly resource: string;
      readonly read: (id: string) => Promise<unknown>;
    }[] = [
      { resource: 'account', read: (id) => getAccount(id, ctx) },
      { resource: 'fiscal_period', read: (id) => getPeriod({ periodId: id }) },
      {
        resource: 'journal',
        read: (id) =>
          reverseJournal(
            { journalId: id, date: '2026-04-30', actorType: 'user', actorId: ctx.actorId },
            ctx,
          ),
      },
      { resource: 'org', read: (id) => resolveOrgMembership(built.stranger.userId, id) },
    ];

    const ids: Record<string, string> = {
      account: built.accountId,
      fiscal_period: built.periodId,
      journal: built.journalId,
      org: built.owner.orgId,
    };

    const verdicts: Record<string, unknown> = {};
    for (const { resource, read } of reads) {
      const attempt = async (id: string): Promise<unknown> =>
        runInContext(ctx, () => read(id)).then(
          () => 'did not throw',
          (error: unknown) => toWireError(error),
        );

      const crossOrg = await attempt(ids[resource] as string);
      const nonexistent = await attempt(NOWHERE);

      verdicts[resource] = {
        crossOrg,
        // Serialized before comparing, because the claim is that the two are
        // indistinguishable *on the wire* — which is a claim about the bytes, not about
        // two error objects being the same object.
        matchesNonexistent: JSON.stringify(crossOrg) === JSON.stringify(nonexistent),
      };
    }

    expect(verdicts).toEqual(
      Object.fromEntries(
        Object.keys(ids).map((resource) => [
          resource,
          {
            // The `resource` name in `details` is the *asked-about kind*, never the
            // asked-about object, so it carries no existence information — and having
            // it differ per resource is what makes each pair's equality meaningful
            // rather than an artefact of one shared message.
            crossOrg: {
              code: 'not_found',
              status: 404,
              message: `No such ${resource}.`,
              details: { resource },
            },
            matchesNonexistent: true,
          },
        ]),
      ),
    );
  });
});
