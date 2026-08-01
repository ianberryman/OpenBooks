import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDEMPOTENCY_KEY_HEADER } from '../../src/transport/index';
import type { App } from '../../src/transport/index';
import { buildTestApp, errorBody } from './harness';

/**
 * The `/v1` surface, asserted without a database.
 *
 * Request *validation* is not asserted here and cannot be: `requireOrgScope` is an
 * `onRequest` hook, so an org-scoped route refuses an unauthenticated caller before
 * the body is parsed. Every validation case — the money format above all — therefore
 * needs a session and lives in `./v1.test.ts`.
 *
 * What is left is decided entirely by the hook chain, so none of it needs a connection
 * and none of it may open one. That is not a speed argument: a test that reached the
 * database could not tell "refused at the edge" from "refused after a query", and the
 * whole value of the two `onRequest` hooks is that they refuse first. This process
 * never calls `initializeDatabase`, so any query at all would be a 500 — which is what
 * makes the 401s below evidence rather than coincidence.
 *
 * The write cases are **enumerated from the route table itself**, via the document
 * `@fastify/swagger` built from it. A hand-written list would fall behind the moment a
 * route was added, and silently: the new route would simply not be covered, which is
 * the failure mode this rule exists to prevent.
 */

let app: App;

beforeAll(async () => {
  ({ app } = await buildTestApp());
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/**
 * Narrower than Fastify's `HTTPMethods`, which `inject` does not accept in full — and
 * narrow deliberately: a method appearing here that this API does not use would be a
 * finding, not something to widen the type for.
 */
type RouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Operation {
  readonly method: RouteMethod;
  /** With `{param}` segments replaced by a well-formed UUID, so the route matches. */
  readonly url: string;
  readonly operationId: string;
  readonly parameters: readonly { in: string; name: string; required?: boolean }[];
}

const SOME_UUID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function v1Operations(): readonly Operation[] {
  // Through `unknown`: the plugin's `Document` type describes a path item as a union
  // including plain strings (`description`), so it does not overlap the shape this test
  // walks. The document is data, and the assertions below are what check it.
  const document = app.swagger() as unknown as {
    paths: Record<string, Record<string, { operationId: string; parameters?: unknown[] }>>;
  };

  return Object.entries(document.paths)
    .filter(([path]) => path.startsWith('/v1/'))
    .flatMap(([path, item]) =>
      Object.entries(item).map(([method, operation]) => ({
        method: method.toUpperCase() as RouteMethod,
        url: path.replaceAll(/\{[^}]+\}/gu, SOME_UUID),
        operationId: operation.operationId,
        parameters: (operation.parameters ?? []) as Operation['parameters'],
      })),
    );
}

function writes(): readonly Operation[] {
  return v1Operations().filter((operation) => operation.method !== 'GET');
}

describe('the /v1 route table', () => {
  it('covers every operation the ticket names', () => {
    expect(new Set(v1Operations().map((operation) => operation.operationId))).toEqual(
      new Set([
        'register',
        'login',
        'logout',
        'getCurrentIdentity',
        'createOrg',
        'listOrgMemberships',
        'switchActiveOrg',
        'createAccount',
        'listAccounts',
        'getAccount',
        'updateAccount',
        'deactivateAccount',
        'reactivateAccount',
        'deleteAccount',
        'generateFiscalYear',
        'createFiscalPeriod',
        'listFiscalPeriods',
        'closeFiscalPeriod',
        'reopenFiscalPeriod',
        'getPeriodCloseChecklist',
        'postJournal',
        'reverseJournal',
        'listJournals',
        'getTrialBalance',
        // OB-045.
        'listChartTemplates',
        'applyChartTemplate',
        'createContact',
        'listContacts',
        'getContact',
        'updateContact',
        'deactivateContact',
        'reactivateContact',
        'deleteContact',
        // Item catalog (initiative CAT).
        'createCatalogItem',
        'listCatalogItems',
        'getCatalogItem',
        'updateCatalogItem',
        'deactivateCatalogItem',
        'reactivateCatalogItem',
        'createDimension',
        'listDimensions',
        'getDimension',
        'updateDimension',
        'archiveDimension',
        'unarchiveDimension',
        'deleteDimension',
        'createDimensionValue',
        'listDimensionValues',
        'getDimensionValue',
        'updateDimensionValue',
        'archiveDimensionValue',
        'unarchiveDimensionValue',
        'deleteDimensionValue',
        'getJournalLineDimensions',
        'setJournalLineDimensions',
        'createDraft',
        'listDrafts',
        'getDraft',
        'updateDraft',
        'discardDraft',
        'postDraft',
        'listMembers',
        'changeMemberRole',
        'removeMember',
        'listAssignableRoles',
        'inviteMember',
        'listInvites',
        'revokeInvite',
        'acceptInvite',
        'getProfitAndLoss',
        'getBalanceSheet',
        'getGeneralLedger',
        // K (cash-basis reporting): the two cash-flow statements (OB-157, OB-158).
        'getStatementOfCashFlows',
        'getCashFlowProjection',
        // N (budgets): the budget-vs-actual report (OB-182), reports.read like the rest.
        'getBudgetVsActual',
        // P (accountant access & period close, OB-197): the audit trail (audit.read)
        // and the statement package (reports.read). The close checklist rides with the
        // fiscal-period operations above.
        'getAuditReport',
        'createStatementPackage',
        'listStatementPackages',
        // OB-067 — the `/v1` surface for everything M3 adds.
        'getControlAccounts',
        'updateControlAccounts',
        'createTaxRate',
        'listTaxRates',
        'getTaxRate',
        'updateTaxRate',
        'archiveTaxRate',
        'unarchiveTaxRate',
        'deleteTaxRate',
        'createInvoice',
        'listInvoices',
        'invoicesSummary',
        'getInvoice',
        'updateInvoice',
        'discardInvoice',
        'approveInvoice',
        'voidInvoice',
        // Phase 4: recurring invoice templates, dunning policies, and the manual scheduler run.
        'createRecurringInvoiceTemplate',
        'listRecurringInvoiceTemplates',
        'getRecurringInvoiceTemplate',
        'updateRecurringInvoiceTemplate',
        'deactivateRecurringInvoiceTemplate',
        'createDunningPolicy',
        'listDunningPolicies',
        'getDunningPolicy',
        'updateDunningPolicy',
        'deactivateDunningPolicy',
        'runDueScheduledWork',
        // INV (Phase 1): invoice delivery + the org letterhead it prints under.
        'sendInvoice',
        'getBranding',
        'updateBranding',
        'uploadBrandingLogo',
        'createCreditNote',
        'listCreditNotes',
        'getCreditNote',
        'updateCreditNote',
        'discardCreditNote',
        'approveCreditNote',
        'voidCreditNote',
        'createBill',
        'listBills',
        'billsSummary',
        'getBill',
        'updateBill',
        'discardBill',
        'approveBill',
        'voidBill',
        // Bill capture (initiative O, OB-186…189).
        'createBillCapture',
        'listBillCaptures',
        'getBillCapture',
        'dismissBillCapture',
        'createDraftFromBillCapture',
        'getBillAttachment',
        'getInboundBillEmailAddress',
        'receiveInboundBill',
        'createVendorCredit',
        'listVendorCredits',
        'getVendorCredit',
        'updateVendorCredit',
        'discardVendorCredit',
        'approveVendorCredit',
        'voidVendorCredit',
        'recordPayment',
        'listPayments',
        'getPayment',
        'updatePayment',
        'voidPayment',
        'allocatePayment',
        'allocateCreditNote',
        'allocateVendorCredit',
        'deleteAllocation',
        'getAging',
        // OB-084 — the `/v1` surface for banking (M4).
        'createBankAccount',
        'listBankAccounts',
        'getBankAccount',
        'updateBankAccount',
        'deactivateBankAccount',
        'reactivateBankAccount',
        'previewBankStatementImport',
        'startBankStatementImport',
        'listBankStatementImports',
        'getBankStatementImport',
        'saveBankImportMapping',
        'listBankImportMappings',
        'getBankImportMapping',
        // Phase 3 — the QuickBooks CSV migration import.
        'previewQuickBooksImport',
        'importQuickBooks',
        'listStatementLines',
        'getStatementLine',
        'createManualStatementLine',
        'proposeBankMatches',
        'clearBankStatementLine',
        'removeBankLineClearing',
        'createBankRule',
        'listBankRules',
        'getBankRule',
        'updateBankRule',
        'createReconciliationSession',
        'listReconciliationSessions',
        'getReconciliationSession',
        'updateReconciliationSession',
        'finaliseReconciliationSession',
        'reopenReconciliationSession',
        'getReconciliationReport',
        // M5 — the platform surface (OB-104).
        'listApiKeys',
        'createApiKey',
        'revokeApiKey',
        'listOAuthClients',
        'registerOAuthClient',
        'deactivateOAuthClient',
        'listConnectedApps',
        'revokeConnectedApp',
        'getOAuthAuthorizationDetails',
        'readChangeFeed',
        'createExternalRef',
        'listExternalRefs',
        'lookupExternalRef',
        'listProposals',
        'approveProposal',
        'rejectProposal',
        // Payment integration (OB-150).
        'connectProcessor',
        'listProcessorConnections',
        'getProcessorConnection',
        'deactivateProcessorConnection',
        'reactivateProcessorConnection',
        // Cash application (OB-139).
        'createPaymentTerm',
        'listPaymentTerms',
        'getPaymentTerm',
        'updatePaymentTerm',
        'deactivatePaymentTerm',
        'suggestDiscount',
        'getDiscountAccounts',
        'updateDiscountAccounts',
        // Fixed assets & recurring journals (initiative L, OB-167).
        'createRecurringJournalTemplate',
        'listRecurringJournalTemplates',
        'getRecurringJournalTemplate',
        'updateRecurringJournalTemplate',
        'deactivateRecurringJournalTemplate',
        'registerFixedAsset',
        'listFixedAssets',
        'getFixedAsset',
        'getFixedAssetSchedule',
        'updateFixedAsset',
        'disposeFixedAsset',
        'getDepreciationAccounts',
        'updateDepreciationAccounts',
        // N (budgets): enter/list/delete the figures (OB-183). The budget-vs-actual
        // report is above, with the other reports.
        'setBudgets',
        'listBudgets',
        'deleteBudget',
        // Pay Bills (OB-115).
        'buildPendingPayment',
        'payBills',
        'listPendingPayments',
        'getPendingPayment',
        'updatePendingPayment',
        'cancelPendingPayment',
        'issuePendingPayment',
        'issuePendingPayments',
        'listPayableBills',
        'listDisbursementsByRail',
        'getVendorDisbursementDetails',
        'updateVendorDisbursementDetails',
        // Procure-to-pay (M, OB-175): purchase orders, estimates, employee expenses,
        // and the lean send path for the two pre-documents.
        'createPurchaseOrder',
        'listPurchaseOrders',
        'purchaseOrdersSummary',
        'getPurchaseOrder',
        'updatePurchaseOrder',
        'approvePurchaseOrder',
        'convertPurchaseOrderToBill',
        'discardPurchaseOrder',
        'createEstimate',
        'listEstimates',
        'estimatesSummary',
        'getEstimate',
        'updateEstimate',
        'approveEstimate',
        'convertEstimateToInvoice',
        'discardEstimate',
        'createExpense',
        'listExpenses',
        'getExpense',
        'updateExpense',
        'approveExpense',
        'discardExpense',
        'sendPurchaseOrder',
        'sendEstimate',
        // Q (M6): automations + the agent work queue.
        'createAutomation',
        'listAutomations',
        'getAutomation',
        'updateAutomation',
        'activateAutomation',
        'deactivateAutomation',
        'runAutomation',
        'listWorkItems',
        'getWorkItem',
        'cancelWorkItem',
      ]),
    );
  });

  it('has writes, and they are not all one method', () => {
    // Guards the enumeration itself: a filter bug that matched nothing would make
    // every case below pass vacuously.
    expect(new Set(writes().map((operation) => operation.method))).toEqual(
      // `PUT` is OB-045's retag, and the only one: it replaces the complete set of a
      // line's dimension values, where every other write here creates, patches, or
      // removes.
      new Set(['POST', 'PUT', 'PATCH', 'DELETE']),
    );
  });
});

/**
 * Spec §12: every write endpoint requires an `Idempotency-Key`.
 *
 * Asserted twice over, because the requirement has two audiences. The hook is what
 * refuses the request; the documented parameter is what a generated client (OB-024)
 * reads in order to send the header at all. A requirement enforced but undocumented
 * is a client whose every write fails with a 400.
 */
describe('Idempotency-Key on every write', () => {
  it('refuses a write that does not carry one', async () => {
    for (const operation of writes()) {
      const response = await app.inject({
        method: operation.method,
        url: operation.url,
        payload: {},
      });

      expect(response.statusCode, `${operation.method} ${operation.url}`).toBe(400);
      const body = errorBody(response.body);
      expect(body.error.code, operation.operationId).toBe('validation_failed');
      expect(body.error.details?.['issues'], operation.operationId).toEqual([
        { path: IDEMPOTENCY_KEY_HEADER, message: 'must be set' },
      ]);
    }
  });

  it('declares it as a required header in the published document', () => {
    for (const operation of writes()) {
      const header = operation.parameters.find(
        (parameter) => parameter.in === 'header' && parameter.name === IDEMPOTENCY_KEY_HEADER,
      );
      expect(header, `${operation.method} ${operation.url}`).toMatchObject({ required: true });
    }
  });

  it('does not require one on a read', async () => {
    // A read carrying no key must not be refused for the *absence* of one. Reads still
    // reach the service, which refuses an unauthenticated caller — 401, never 400.
    for (const operation of v1Operations().filter((op) => op.method === 'GET')) {
      const response = await app.inject({ method: 'GET', url: operation.url });

      expect(response.statusCode, operation.operationId).toBe(401);
      expect(errorBody(response.body).error.code, operation.operationId).toBe('unauthenticated');
    }
  });
});

/**
 * A7 applied to the route table: an unauthenticated caller must be told `401`, not
 * `403` and not `404`.
 *
 * A `403` would assert that the caller is known and unauthorized, which is a different
 * fact and the wrong one. A `404` on a collection route would deny the endpoint exists.
 */
describe('unauthenticated requests', () => {
  it('answers 401 on an org-scoped write, before any query', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/accounts',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'unauthenticated-write' },
      payload: { code: '1000', name: 'Cash', type: 'asset', normalBalance: 'debit' },
    });

    expect(response.statusCode).toBe(401);
    expect(errorBody(response.body).error.code).toBe('unauthenticated');
  });

  /**
   * The reason `requireOrgScope` exists. `withIdempotency` claims a row in
   * `idempotency_keys`, whose `org_id` is a foreign key to `orgs`, so a request still
   * carrying the pre-auth sentinel would fail that key and answer 500 — and this
   * process has no database at all, so any query would answer 500 too. A 401 is
   * therefore proof that nothing was attempted.
   */
  it('does not reach the database to decide that', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/journals',
      headers: { [IDEMPOTENCY_KEY_HEADER]: 'unauthenticated-post' },
      payload: {
        date: '2026-03-31',
        lines: [
          { accountId: SOME_UUID, side: 'debit', amount: '1' },
          { accountId: SOME_UUID, side: 'credit', amount: '1' },
        ],
      },
    });

    expect(response.statusCode).toBe(401);
  });

  it('leaves login and register reachable', async () => {
    // Reachable means "not refused for want of credentials". Both then fail on the
    // database this process does not have, which is a 500 — and a 500 here is the proof
    // the request got past every gate.
    for (const url of ['/v1/auth/login', '/v1/auth/register']) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { [IDEMPOTENCY_KEY_HEADER]: `reachable-${url}` },
        payload: {
          email: 'someone@example.invalid',
          password: 'x'.repeat(20),
          displayName: 'A',
          org: { name: 'A' },
        },
      });

      expect(response.statusCode, url).not.toBe(401);
      expect(response.statusCode, url).not.toBe(403);
    }
  });
});
