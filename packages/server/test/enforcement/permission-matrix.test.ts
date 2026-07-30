import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runInContext, type RequestContext } from '../../src/context';
import { uuidToBuffer } from '../../src/db';
import { toWireError } from '../../src/errors';
import {
  createLocalSecretsProvider,
  InProcessQueue,
  setQueueProvider,
  setSecretsProvider,
} from '../../src/providers';
import {
  applyChartTemplate,
  createAccount,
  deactivateAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  listChartTemplates,
  reactivateAccount,
  updateAccount,
} from '../../src/modules/accounts';
import {
  approveBill,
  approveVendorCredit,
  createBill,
  createCaptureFromUpload,
  createDraftFromCapture,
  createVendorCredit,
  discardBill,
  discardVendorCredit,
  dismissCapture,
  getBill,
  getBillAttachment,
  getCapture,
  getVendorCredit,
  listBills,
  listCaptures,
  listVendorCredits,
  updateBill,
  updateVendorCredit,
  voidBill,
  voidVendorCredit,
} from '../../src/modules/bills';
import {
  createContact,
  deactivateContact,
  deleteContact,
  getContact,
  listContacts,
  reactivateContact,
  updateContact,
} from '../../src/modules/contacts';
import {
  archiveDimension,
  archiveDimensionValue,
  createDimension,
  createDimensionValue,
  deleteDimension,
  deleteDimensionValue,
  getDimension,
  getDimensionValue,
  getJournalLineDimensions,
  listDimensions,
  listDimensionValues,
  setJournalLineDimensions,
  unarchiveDimension,
  unarchiveDimensionValue,
  updateDimension,
  updateDimensionValue,
} from '../../src/modules/dimensions';
import {
  createDraft,
  discardDraft,
  getDraft,
  listDrafts,
  postDraft,
  updateDraft,
} from '../../src/modules/drafts';
import { approveProposal, listProposals, rejectProposal } from '../../src/modules/agents';
import { createApiKey, listApiKeys, revokeApiKey } from '../../src/modules/api-keys';
import { readChangeFeed } from '../../src/modules/change-feed';
import {
  createExternalRef,
  listExternalRefs,
  lookupExternalRef,
} from '../../src/modules/external-refs';
import { importQuickBooks, previewQuickBooksImport } from '../../src/modules/imports';
import {
  deactivateOAuthClient,
  listConnectedApps,
  listOAuthClients,
  registerOAuthClient,
  revokeConnectedApp,
} from '../../src/modules/oauth';
import {
  createDunningPolicy,
  createRecurringInvoiceTemplate,
  deactivateDunningPolicy,
  deactivateRecurringInvoiceTemplate,
  getDunningPolicy,
  getRecurringInvoiceTemplate,
  listDunningPolicies,
  listRecurringInvoiceTemplates,
  updateDunningPolicy,
  updateRecurringInvoiceTemplate,
} from '../../src/modules/invoicing';
import { runDueWorkNow } from '../../src/modules/scheduling';
import {
  approveCreditNote,
  approveInvoice,
  createCreditNote,
  createInvoice,
  discardCreditNote,
  discardInvoice,
  getCreditNote,
  getInvoice,
  listCreditNotes,
  listInvoices,
  updateCreditNote,
  updateInvoice,
  voidCreditNote,
  voidInvoice,
} from '../../src/modules/invoices';
import { getBranding, updateBranding, uploadLogo } from '../../src/modules/branding';
import { sendInvoice } from '../../src/modules/delivery';
import {
  getTrialBalance,
  listJournals,
  postJournal,
  reverseJournal,
} from '../../src/modules/ledger';
import {
  changeMemberRole,
  inviteMember,
  listAssignableRoles,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
} from '../../src/modules/members';
import {
  allocateCreditNote,
  allocatePayment,
  allocateVendorCredit,
  deleteAllocation,
  getPayment,
  listPayments,
  recordPayment,
  updatePayment,
  voidPayment,
} from '../../src/modules/payments';
import {
  clearBankStatementLine,
  createBankAccount,
  createBankRule,
  createReconciliationSession,
  deactivateBankAccount,
  finaliseReconciliationSession,
  getBankAccount,
  getBankImportMapping,
  getBankRule,
  getBankStatementImport,
  getReconciliationReport,
  getReconciliationSession,
  getStatementLine,
  listBankAccounts,
  listBankImportMappings,
  listBankRules,
  listBankStatementImports,
  listReconciliationSessions,
  listStatementLines,
  previewImportWithParsers,
  proposeMatchesWithRules,
  reactivateBankAccount,
  removeBankLineClearing,
  reopenReconciliationSession,
  saveBankImportMapping,
  startImport,
  updateBankAccount,
  updateBankRule,
  updateReconciliationSession,
} from '../../src/modules/banking';
import type { PermissionKey } from '../../src/modules/permissions';
import { PERMISSION_KEYS, selectCatalogCodes } from '../../src/modules/permissions';
import {
  closePeriod,
  computeCloseChecklist,
  createPeriod,
  generateFiscalYear,
  getPeriod,
  listPeriods,
  reopenPeriod,
} from '../../src/modules/periods';
import { deleteBudget, listBudgets, setBudgets } from '../../src/modules/budgets';
import {
  getAccountBalances,
  getAuditReport,
  getBalanceSheet,
  getBudgetVsActual,
  getCashFlowProjection,
  getGeneralLedger,
  getProfitAndLoss,
  getStatementOfCashFlows,
} from '../../src/modules/reports';
import { createStatementPackage, listStatementPackages } from '../../src/modules/statements';
/**
 * Not through `modules/reports`' index, and OB-067 did not change that.
 *
 * OB-065 landed `getAging` without exporting it from the barrel, and
 * `src/transport/routes/reports.ts` now imports the service file directly for the
 * same reason — the only barrel bypass in that directory. Recorded here rather than
 * fixed: the export is a one-line change in `src/modules/reports/index.ts`, and
 * OB-072 may not touch `src/`.
 */
import { getAging } from '../../src/modules/reports/aging.service';
import { getInboundEmailAddress } from '../../src/modules/orgs';
import {
  createPaymentTerm,
  deactivatePaymentTerm,
  getPaymentTerm,
  listPaymentTerms,
  suggestDiscount,
  updatePaymentTerm,
} from '../../src/modules/payment-terms';
import {
  connectProcessor,
  deactivateProcessorConnection,
  getProcessorConnection,
  listProcessorConnections,
  reactivateProcessorConnection,
} from '../../src/modules/payments-processing';
import {
  buildPendingPayment,
  cancelPendingPayment,
  getPendingPayment,
  getVendorDisbursementDetails,
  issuePendingPayment,
  issuePendingPayments,
  listDisbursementsByRail,
  listPayableBills,
  listPendingPayments,
  payBills,
  updatePendingPayment,
  updateVendorDisbursementDetails,
} from '../../src/modules/pay-bills';
import {
  disposeFixedAsset,
  getFixedAsset,
  getFixedAssetSchedule,
  listFixedAssets,
  registerFixedAsset,
  updateFixedAsset,
} from '../../src/modules/fixed-assets';
import {
  createRecurringJournalTemplate,
  deactivateRecurringJournalTemplate,
  getRecurringJournalTemplate,
  listRecurringJournalTemplates,
  updateRecurringJournalTemplate,
} from '../../src/modules/recurring-journals';
import {
  approveEstimate,
  convertEstimateToInvoice,
  createEstimate,
  discardEstimate,
  getEstimate,
  listEstimates,
  updateEstimate,
} from '../../src/modules/estimates';
import {
  approveExpense,
  createExpense,
  discardExpense,
  getExpense,
  listExpenses,
  updateExpense,
} from '../../src/modules/expenses';
import {
  approvePurchaseOrder,
  convertPurchaseOrderToBill,
  createPurchaseOrder,
  discardPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from '../../src/modules/purchase-orders';
import { sendEstimate, sendPurchaseOrder } from '../../src/modules/predocument-delivery';
import {
  getControlAccounts,
  getDepreciationAccounts,
  getDiscountAccounts,
  updateControlAccounts,
  updateDepreciationAccounts,
  updateDiscountAccounts,
} from '../../src/modules/settings';
import {
  archiveTaxRate,
  createTaxRate,
  deleteTaxRate,
  getTaxRate,
  listTaxRates,
  unarchiveTaxRate,
  updateTaxRate,
} from '../../src/modules/tax';
import { generateOpenApiDocument } from '../../src/transport';
import { silentLogger } from '../banking/support';
import { newUuid, SYSTEM_ROLE_UUIDS, systemRoleId, type SystemRoleName } from '../db';
import { captureEmail } from '../members/support';
import { useServiceDatabase } from '../permissions/support';
import { buildTestApp } from '../transport/harness';
import { contextFor } from './support';

/**
 * **B10 — every M2 operation, against every seeded role, at the service.**
 *
 * ## Why this is a service-layer matrix and not a route-layer one
 *
 * D-25 decides that the permission set `GET /v1/me` returns is *advisory*: screens
 * hide what the caller cannot do, and the service refuses regardless. A matrix
 * driven through `app.inject` would exercise the routes, and the routes hold no
 * authorization at all — `requirePermission` is service-layer only and
 * dependency-cruiser enforces it. So a route-level matrix would be asserting that
 * the advisory layer happens to agree with the gate, which is the one thing D-25
 * says not to trust. Every row below calls the service function directly, inside
 * the context scope the request path opens.
 *
 * ## How a row is judged
 *
 * The only question asked is *did the gate refuse* — an operation that gets past
 * `requirePermission` and then fails on a precondition, a missing row, or a closed
 * period is `allowed`, because the gate let it through. That is deliberate: the
 * matrix is about authority, not about applicability, and tying the two together
 * would make a verdict depend on the order rows happen to run in.
 *
 * That leaves one way for a row to be vacuous — a service with no gate at all
 * would read `allowed` for every role and look like a wide-open read. `nobody`
 * closes it: an extra pass with a role id naming no row, which
 * `permissions.service.ts` documents as resolving to the empty set. Every
 * operation must be refused for it, *and* the key it is refused with must be the
 * key the row declares. So each row's declared permission is verified against the
 * one the service actually checks, rather than being a comment.
 *
 * ## What happened at M3 (OB-072, acceptance C11)
 *
 * The paragraph that stood here predicted this: "when M3 adds its first invoice
 * operation, `GRANTED_TO` gains a row reading `invoices.write: owner, bookkeeper,
 * arOnly` and `LATENT_GRANTS` loses that code from four roles, in the same commit,
 * with no migration between them." That is what this commit is. It is recorded
 * rather than deleted because the mechanism only means something if someone can
 * see it fire.
 *
 * **Eighteen codes moved** out of `LATENT_GRANTS` and into `GRANTED_TO`, taking the
 * enforced set from seventeen to thirty-five and the latent set from thirty-one to
 * thirteen. Sixteen came from the five subledger services —
 * `invoices.{read,write,void}`, `credit_notes.{read,write}`,
 * `bills.{read,write,void}`, `vendor_credits.{read,write}`,
 * `payments_received.{read,write}`, `payments_made.{read,write}`,
 * `tax_rates.{read,write}` — and two from `modules/settings`, which gave `orgs.read`
 * and `orgs.write` their first enforcement point anywhere in the system by making
 * the control accounts a per-org nomination. Not one line of `0001_tenancy`
 * changed. Who gained what:
 *
 * | Role       | Codes gained | What it can now do that it could not last week |
 * | ---------- | ------------ | ---------------------------------------------- |
 * | owner      | 18           | everything AR and AP, and the org's settings   |
 * | bookkeeper | 17           | everything AR and AP; reads the settings       |
 * | apOnly     | 8            | bills, vendor credits, payments made           |
 * | arOnly     | 8            | invoices, credit notes, payments received      |
 * | readOnly   | 8            | reads both subledgers and the settings         |
 * | approver   | 8            | reads both subledgers and the settings         |
 *
 * Bookkeeper is the headline the roadmap named, and it is worth stating plainly:
 * **a role was widened by writing a service.** `apOnly` and `arOnly` went from
 * eight latent codes each to none — every code they hold is now live, which is the
 * first time either role has meant anything at all. Owner is the one to look at
 * twice: it gained `orgs.write`, which decides where every future invoice and bill
 * posts, and no migration recorded that either.
 *
 * What is left latent is `workflows.*` (M6), which has no milestone scoped at all.
 * **No `banking.*` code is latent any longer**: wave 1 took `banking.import` and
 * `banking.read` live, wave 2 `banking.match`, and wave 3 `banking.reconcile` and
 * `banking.reopen` — each the moment a service enforced it, exactly as the AR/AP
 * services did to their codes. M4 emptied the banking half of this table over three
 * waves without a migration. **Nor is any M5 code latent any longer**: OB-104 gave
 * `agents.review`, `api_keys.read`, `api_keys.write`, `integrations.read` and
 * `integrations.write` their routes in the same commit that moved them into
 * `GRANTED_TO` below — the platform surface emptied its own half of this table in
 * one commit rather than the three M4 took, because every one of its five codes
 * got an enforcement point at once.
 *
 * ## And what OB-072 added to it
 *
 * The rows above were written against the services while the routes were still
 * OB-067's job, so `operationId` was `null` on fifty-one of them and the coverage
 * check below could not see any of it. Filling those in is what closes C11's second
 * half: the matrix is now compared against every gated operation the API publishes,
 * and a route added without a row fails here rather than shipping unasserted. Two
 * rows still carry `null` — `getPeriod` and `getAccountBalances`, which have no
 * route at all — and the source scan is what covers those.
 *
 * ## Two things this milestone made visible, and neither is fixed here
 *
 * `ar_only` and `ap_only` **cannot finish a document they are entitled to enter**:
 * approving posts through `postJournal` and voiding through `reverseJournal`, each
 * of which checks the caller's own `journals.post` / `journals.reverse`, and
 * neither role holds either. See `known gap — an AR or AP clerk cannot finish what
 * they started` at the foot of this file. Fixing it is a seed migration and a
 * product decision, not a test change.
 *
 * `credit_notes.void` and `bills.approve` **do not exist in the catalog**, so those
 * two operations take the corresponding `.write`. Asserted below against the
 * catalog itself, so adding either code has to come past this file.
 */
const db = useServiceDatabase();

// `startBankStatementImport` enqueues (D-47). A queue with no handler in this process
// drops the job (and logs it) rather than reaching for a process config these
// service-layer tests never load, so the row reaches its gate and returns cleanly.
//
// `connectProcessor` (OB-150) writes through the secrets provider (D-101). Installed
// directly, the way the queue above is, rather than through `getConfig()` — a
// throwaway `local` adapter and encryption key, for `setEmailProvider`'s reason in
// `test/members/support.ts`: this file's process-wide config is never resolved for
// its own sake.
beforeAll(() => {
  setQueueProvider(new InProcessQueue(silentLogger));
  setSecretsProvider(
    createLocalSecretsProvider({ provider: 'local', encryptionKey: 'k'.repeat(32) }),
  );
});
afterAll(() => {
  setQueueProvider(undefined);
  setSecretsProvider(undefined);
});

// `inviteMember` sends. The real `log` adapter over a capture stream, because a
// stubbed provider would make the one row that exercises `members.write` a test of
// the stub (spec §11).
captureEmail();

const ROLES = [
  'owner',
  'bookkeeper',
  'apOnly',
  'arOnly',
  'readOnly',
  'approver',
  'accountant',
] as const satisfies readonly SystemRoleName[];

/**
 * Which of the six seeded roles hold each permission that has an enforcement point
 * today.
 *
 * Written out rather than read from `role_permissions`, which is the entire point:
 * derived expectations move when the seeds move and a matrix that agrees with the
 * database by construction can never disagree with it. This table is the claim; the
 * database is what it is checked against.
 *
 * Fifty rows, because fifty of the catalog's fifty-three codes are checked by a
 * service. The other three are `workflows.*` — see `LATENT_GRANTS` below. Eighteen
 * arrived with M3 and are marked, three with INV (branding + `invoices.send`), five
 * with M5 (OB-104: `agents.review`, `api_keys.read`, `api_keys.write`,
 * `integrations.read`, `integrations.write`), and two with OB-150 (`processing.read`,
 * `processing.write`); every one of them is a role widened by a service rather than
 * by a migration (C11, known gap 6).
 */
const GRANTED_TO: Readonly<Record<string, readonly SystemRoleName[]>> = {
  'accounts.read': [
    'owner',
    'bookkeeper',
    'apOnly',
    'arOnly',
    'readOnly',
    'approver',
    'accountant',
  ],
  'accounts.write': ['owner', 'bookkeeper'],
  // M4 waves 1–3: the banking codes services now enforce. `banking.import` gates
  // saving a mapping and starting an import; `banking.read` gates the reads, the
  // preview and the match proposals; `banking.match` gates authoring a rule (OB-080)
  // and clearing a line (OB-081); `banking.reconcile` gates opening, updating and
  // finalising a reconciliation session, and `banking.reopen` gates reopening a
  // finalised one (OB-082) — the E6 power to withdraw an assertion, held apart from
  // making one. All five writes are Owner and Bookkeeper; read alone reaches the two
  // read-only roles. No banking code is latent any longer.
  'banking.import': ['owner', 'bookkeeper'],
  'banking.match': ['owner', 'bookkeeper'],
  'banking.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'banking.reconcile': ['owner', 'bookkeeper'],
  'banking.reopen': ['owner', 'bookkeeper'],
  'contacts.read': [
    'owner',
    'bookkeeper',
    'apOnly',
    'arOnly',
    'readOnly',
    'approver',
    'accountant',
  ],
  // AP-only and AR-only hold `contacts.write` — a vendor or a customer is created
  // in the course of entering the bill or the invoice it belongs to.
  'contacts.write': ['owner', 'bookkeeper', 'apOnly', 'arOnly'],
  'dimensions.read': [
    'owner',
    'bookkeeper',
    'apOnly',
    'arOnly',
    'readOnly',
    'approver',
    'accountant',
  ],
  'dimensions.write': ['owner', 'bookkeeper'],
  'journals.read': [
    'owner',
    'bookkeeper',
    'apOnly',
    'arOnly',
    'readOnly',
    'approver',
    'accountant',
  ],
  // Approver holds it, and D-30 turns on exactly that: drafting reuses this code,
  // so a role whose bundle is `%.read` plus `journals.post` can compose a proposal
  // as well as post one. See `Approver composes and posts a draft` below.
  'journals.post': ['owner', 'bookkeeper', 'approver', 'apOnly', 'arOnly', 'accountant'],
  'journals.reverse': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'accountant'],
  'members.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  // One of the two codes Bookkeeper is excluded from — `orgs.write` below is the
  // other. A bookkeeper runs the books; they do not decide who has access.
  'members.write': ['owner'],
  'periods.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver', 'accountant'],
  'periods.write': ['owner', 'bookkeeper'],
  // Not Read-only, even though closing writes no journal: `0001_tenancy` states that
  // closing a period is a change. The `accountant` role does hold both, though — the
  // period-close workflow (P, D-97) is the accountant capability the reopen split was
  // always for, and reopen is the audited restatement half it holds alongside close.
  'periods.close': ['owner', 'bookkeeper', 'accountant'],
  'periods.reopen': ['owner', 'bookkeeper', 'accountant'],
  'reports.read': ['owner', 'bookkeeper', 'apOnly', 'arOnly', 'readOnly', 'approver', 'accountant'],
  'roles.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],

  // ---------------------------------------------------------------------------
  // M3 — the sixteen codes OB-062 … OB-066 gave an enforcement point.
  //
  // Every row below is read off the two `IN (…)` lists in `0001_tenancy`'s
  // `seedSystemRoles`, not derived from them: `ar_only` and `ap_only` are literal
  // enumerations, `read_only` and `approver` are `%.read` minus `api_keys.read`,
  // and `bookkeeper` is the whole catalog minus six administration codes. The
  // asymmetry a reviewer should look at first is that the AR and AP lists are
  // mirror images *of the document codes only* — neither list contains
  // `journals.post` or `journals.reverse`.
  // ---------------------------------------------------------------------------

  'invoices.read': ['owner', 'bookkeeper', 'arOnly', 'readOnly', 'approver', 'accountant'],
  'invoices.write': ['owner', 'bookkeeper', 'arOnly'],
  'invoices.void': ['owner', 'bookkeeper', 'arOnly'],
  'credit_notes.read': ['owner', 'bookkeeper', 'arOnly', 'readOnly', 'approver', 'accountant'],
  // Also what a credit note is *voided* with: the catalog holds no
  // `credit_notes.void`, argued on `ArDocumentKind` in `invoices/kinds.ts` and
  // asserted against the catalog under `the codes the catalog does not hold`.
  'credit_notes.write': ['owner', 'bookkeeper', 'arOnly'],
  'bills.read': ['owner', 'bookkeeper', 'apOnly', 'readOnly', 'approver', 'accountant'],
  // And what a bill is *approved* with, for the same reason: no `bills.approve`.
  'bills.write': ['owner', 'bookkeeper', 'apOnly'],
  'bills.void': ['owner', 'bookkeeper', 'apOnly'],
  'vendor_credits.read': ['owner', 'bookkeeper', 'apOnly', 'readOnly', 'approver', 'accountant'],
  'vendor_credits.write': ['owner', 'bookkeeper', 'apOnly'],
  // The direction split is authorization, not a filter: `payments.service.ts`
  // resolves the payment's own direction and then checks one of these two, so an
  // AR clerk is refused a vendor payment they can see the id of.
  'payments_received.read': ['owner', 'bookkeeper', 'arOnly', 'readOnly', 'approver', 'accountant'],
  'payments_received.write': ['owner', 'bookkeeper', 'arOnly'],
  'payments_made.read': ['owner', 'bookkeeper', 'apOnly', 'readOnly', 'approver', 'accountant'],
  'payments_made.write': ['owner', 'bookkeeper', 'apOnly'],
  // The one M3 code every seeded role holds for reading: both clerks need the rate
  // list to enter a document at all, which is why it is in both `IN (…)` lists.
  'tax_rates.read': [
    'owner',
    'bookkeeper',
    'apOnly',
    'arOnly',
    'readOnly',
    'approver',
    'accountant',
  ],
  // And the one M3 write neither clerk holds. A tax rate is configuration, not a
  // document — `0001_tenancy` gives the clerks `tax_rates.read` and stops there.
  'tax_rates.write': ['owner', 'bookkeeper'],

  // ---------------------------------------------------------------------------
  // INV (Phase 1) — the three codes invoice delivery gave an enforcement point.
  //
  // `branding.read`/`branding.write` gate the org letterhead (`modules/branding`):
  // read flows to the two read-only roles through `%.read`, write is Owner and
  // Bookkeeper like every other configuration write. `invoices.send` (`modules/
  // delivery`) is the AR mirror of the M3 document writes — `0001_tenancy` adds it
  // to `ar_only`'s list so a clerk can send the invoices they raise.
  // ---------------------------------------------------------------------------
  'branding.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'branding.write': ['owner', 'bookkeeper'],
  'invoices.send': ['owner', 'bookkeeper', 'arOnly'],

  /**
   * The two codes that had waited since M1 with no enforcement point anywhere, and
   * got one from `modules/settings` — the org's control-account nominations.
   *
   * `orgs.write` is the widening in this milestone worth the most scrutiny, and it
   * is the only one Bookkeeper did *not* get. `0001_tenancy` excludes `orgs.write`
   * from the bookkeeper bundle by name, and `control-accounts.ts` chose that code
   * over `accounts.write` precisely because of the exclusion: nominating a control
   * account decides where every future invoice and bill lands, and the role that
   * enters documents is not the role that decides the shape of the books. The
   * consequence, stated because a reviewer should weigh it: a Bookkeeper cannot fix
   * an org that has nominated nothing, and every approval in that org refuses until
   * an Owner acts.
   */
  'orgs.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'orgs.write': ['owner'],

  /**
   * M5 (OB-097 … OB-104) — the five codes that waited since M1/M6-scoping with no
   * enforcement point, wired by the platform surface. Read straight off the
   * `LATENT_GRANTS` rows they moved out of, not re-derived: `agents.review` was on
   * owner, bookkeeper and approver; `integrations.read` was on owner, bookkeeper,
   * readOnly and approver; `api_keys.read`/`api_keys.write`/`integrations.write`
   * were on owner alone. No migration ran — the widening is this commit, the same
   * shape C11 recorded for M3.
   */
  'agents.review': ['owner', 'bookkeeper', 'approver'],
  'api_keys.read': ['owner'],
  'api_keys.write': ['owner'],
  'integrations.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'integrations.write': ['owner'],

  /**
   * Payment integration (OB-150) — the two codes `connections.service.ts` now
   * enforces, read straight off the `LATENT_GRANTS` rows they moved out of, the
   * same way the M5 block above was: `processing.read` was on owner, bookkeeper,
   * readOnly and approver (the `%.read` bundle); `processing.write` was on owner
   * alone — bookkeeper is excluded from it by name, the same administration
   * exclusion `integrations.write` carries (D-101). No migration ran.
   */
  'processing.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'processing.write': ['owner'],

  /**
   * Pay Bills (OB-111, OB-112) — the three codes `modules/pay-bills` enforces, and
   * the milestone whose whole point is a *real* separation of duties (D-109). Read
   * straight off `0001_tenancy`'s seeds: `pending_payments.read`/`.write` are the
   * queue keys, given to `ap_only` explicitly (the clerk builds the queue) on top of
   * owner and bookkeeper — and read reaches the two read-only roles through `%.read`.
   * `disbursements.issue` is owner **only**: it is excluded from the bookkeeper
   * catch-all by name, precisely so the role that builds the queue is not the role
   * that releases it. `ap_only` holds both queue keys and not `disbursements.issue`,
   * which is the split made real — a clerk can queue a payment and cannot pay it.
   */
  'pending_payments.read': ['owner', 'bookkeeper', 'apOnly', 'readOnly', 'approver', 'accountant'],
  'pending_payments.write': ['owner', 'bookkeeper', 'apOnly'],
  'disbursements.issue': ['owner'],

  // ---------------------------------------------------------------------------
  // L — the four codes initiative L's services enforce (OB-162…166). No SoD
  // split (D-117): the writes are Owner and Bookkeeper, and the reads reach the
  // two read-only roles through `%.read`, read straight off `0001_tenancy`'s
  // seeds. Unlike Pay Bills there is no release key held back — the automated
  // posts run through `postJournal` under the automation's own Owner role, so a
  // `.write` is the whole of the authority. The routes arrive in OB-167, but the
  // services gate now, so these are `GRANTED_TO` rather than latent.
  // ---------------------------------------------------------------------------
  'recurring_journals.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'recurring_journals.write': ['owner', 'bookkeeper'],
  'fixed_assets.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'fixed_assets.write': ['owner', 'bookkeeper'],

  // ---------------------------------------------------------------------------
  // M — procure-to-pay (OB-170…179). Purchase orders and estimates are
  // non-posting pre-documents; an employee expense is an ap_documents bill
  // against an employee contact. The clerk who owns each side gets its write:
  // apOnly raises purchase orders and enters expenses, arOnly raises estimates.
  // Reads reach the two read-only roles through `%.read`. `expenses.approve` is a
  // real separation of duties (like `disbursements.issue`): approving an expense
  // into a payable is held by owner, bookkeeper and approver — NOT the ap clerk
  // who entered it. Converting a pre-document also gates on the target document's
  // write (`bills.write`/`invoices.write`), captured as `thenRequires` below.
  // ---------------------------------------------------------------------------
  'purchase_orders.read': ['owner', 'bookkeeper', 'apOnly', 'readOnly', 'approver', 'accountant'],
  'purchase_orders.write': ['owner', 'bookkeeper', 'apOnly'],
  'estimates.read': ['owner', 'bookkeeper', 'arOnly', 'readOnly', 'approver', 'accountant'],
  'estimates.write': ['owner', 'bookkeeper', 'arOnly'],
  'expenses.read': ['owner', 'bookkeeper', 'apOnly', 'readOnly', 'approver', 'accountant'],
  'expenses.write': ['owner', 'bookkeeper', 'apOnly'],
  'expenses.approve': ['owner', 'bookkeeper', 'approver'],

  // ---------------------------------------------------------------------------
  // N — budgets (OB-180…184). A budget posts no journal (D-94), so there is no
  // separation-of-duties release gate — a plain read/write pair (D-N6), the L
  // block's own shape: `.write` to owner and bookkeeper, `.read` reaching the two
  // read-only roles through `%.read`. Not to ap_only/ar_only. The budget-vs-actual
  // report gates on `reports.read`, not on these. The service gates now, so these
  // are `GRANTED_TO` rather than latent.
  // ---------------------------------------------------------------------------
  'budgets.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
  'budgets.write': ['owner', 'bookkeeper'],

  // ---------------------------------------------------------------------------
  // P — accountant access & period close (OB-192…199). One new code: `audit.read`
  // gates the audit-trail report (`reports/audit.service.ts`). It reaches every
  // role that holds the `%.read` bundle — owner, bookkeeper, and the two read-only
  // roles readOnly/approver — plus the new `accountant` role, and not the AP/AR
  // clerks whose `IN (…)` lists do not name it. The rest of P reuses codes already
  // above: `periods.close`/`periods.reopen` (the close workflow), `journals.post`
  // (an adjusting entry, flagged by `journals.source` not a permission), and
  // `reports.read` (the statement package renders reports the holder can run).
  // ---------------------------------------------------------------------------
  'audit.read': ['owner', 'bookkeeper', 'readOnly', 'approver', 'accountant'],
};

/**
 * Everything each role holds that **nothing checks** — known gap 6, enumerated.
 *
 * A code in this table is a capability the role has been granted and cannot
 * currently exercise, because no service calls `requirePermission` with it. The
 * moment someone writes that call, the code moves from here into `GRANTED_TO` and
 * the role silently gains a power it always held.
 *
 * M3 is the first time that happened at scale, and the diff is the record of it:
 * Bookkeeper's list went from twenty-six entries to nine, Owner's from thirty-one
 * to thirteen, and **`apOnly` and `arOnly` emptied entirely** — the two roles that
 * existed to make the AR/AP half of the catalog meaningful now hold nothing they
 * cannot use. No migration ran.
 *
 * What is left is one milestone's worth, and `workflows.*` is all of it.
 * `banking.*` is fully wired: wave 1 took `banking.import` and `banking.read` off
 * Bookkeeper and Owner (and `banking.read` off each reader), wave 2 took
 * `banking.match`, and wave 3 took `banking.reconcile` and `banking.reopen` — each
 * the moment a service enforced it, so the banking half of this table is empty.
 * The platform half is empty too, as of this commit: `agents.review`,
 * `api_keys.read`, `api_keys.write`, `integrations.read` and `integrations.write`
 * all got an enforcement point at once (OB-104's routes), so — unlike the M3 and
 * M4 sets, which each emptied over several commits — the whole M5 set moved to
 * `GRANTED_TO` together. `workflows.*` is the only code family left with no
 * milestone scoped at all, on Owner and Bookkeeper (`workflows.read`/`write`) and
 * Owner alone (`workflows.activate`).
 */
const LATENT_GRANTS: Readonly<Record<SystemRoleName, readonly string[]>> = {
  // `agents.review`, `api_keys.read`, `api_keys.write`, and `integrations.write`
  // moved to `GRANTED_TO` at M5 (OB-104); `processing.read`/`processing.write` moved
  // this milestone (OB-150) — the `connections.service.ts` routes enforce them now,
  // the same catalog-before-enforcement pattern `agents.review` followed through M5.
  //
  // `workflows.*` is the only family still latent, with no milestone scoped at all.
  // Procure-to-pay's seven codes (M) were latent for exactly one wave — the schema
  // wave seeded them ahead of enforcement — and moved into `GRANTED_TO` the moment
  // the M services gated them (this commit), so they are not here.
  owner: ['workflows.activate', 'workflows.read', 'workflows.write'],
  bookkeeper: ['workflows.read', 'workflows.write'],
  // Empty since M3. Every code `0001_tenancy` grants an AP/AR clerk now has an
  // enforcement point — procure-to-pay's purchase_orders.*/expenses.*/estimates.*
  // gate the moment they are seeded (M), so neither clerk holds anything latent.
  apOnly: [],
  arOnly: [],
  readOnly: ['workflows.read'],
  approver: ['workflows.read'],
  // Accountant holds the `%.read` bundle, so `workflows.read` reaches it for the same
  // reason it reaches readOnly/approver — and nothing else is latent: its four
  // non-read grants (`journals.post`/`journals.reverse`, `periods.close`/
  // `periods.reopen`) are all enforced.
  accountant: ['workflows.read'],
};

/** Everything a matrix row needs in the org it is being run against. */
interface Scene {
  readonly ctx: RequestContext;
  readonly orgUuid: string;
  readonly cashId: string;
  readonly revenueId: string;
  readonly periodId: string;
  readonly date: string;
  readonly journalId: string;
  readonly journalLineId: string;
  readonly contactId: string;
  readonly dimensionId: string;
  readonly dimensionValueId: string;
  readonly draftId: string;
  readonly discardableDraftId: string;
  readonly inviteId: string;
  readonly otherUserId: string;
  readonly actorId: string;

  /**
   * M3's fixtures (OB-062 … OB-066), every one of them built by an Owner.
   *
   * There are four of most document kinds rather than one, and that is what makes
   * the compound rows below mean anything. A row is judged on whether the gate
   * refused, so an `approveInvoice` that failed on "already approved" reads
   * `allowed` and would hide the `journals.post` refusal that is the whole finding
   * — and a single shared document would be consumed by whichever row ran first.
   * One document per operation removes the ordering dependency entirely.
   */
  readonly partyId: string;
  readonly receivableId: string;
  readonly payableId: string;
  readonly expenseId: string;
  readonly bankId: string;
  /**
   * The `bank_accounts` row (D-46: a ledger account plus import metadata), pointing
   * at `bankId`. It exists so the `banking.import` row below can save a mapping
   * against a real account — a permitted role has to reach the write, not stop at a
   * 404, or the row would read `allowed` for the wrong reason.
   */
  readonly bankAccountId: string;
  /**
   * A finalised session on a second bank account, so the `banking.reopen` row has
   * something to reopen without colliding with the session `banking.reconcile` opens.
   */
  readonly reconciliationSessionId: string;
  /**
   * An *open* session on a third bank account (D-45), for the `getReconciliationSession`,
   * `updateReconciliationSession` and `finaliseReconciliationSession` rows. A third
   * account because `createReconciliationSession` opens one on `bankAccountId` and the
   * finalised one lives on the second — one open session per account (`open_marker`).
   */
  readonly openReconciliationSessionId: string;
  /** A saved import mapping on `bankAccountId`, for `getBankImportMapping`. */
  readonly bankImportMappingId: string;
  /** A complete statement import on `bankAccountId`, for `getBankStatementImport`. */
  readonly bankImportId: string;
  /** A bank rule, for `getBankRule` and `updateBankRule`. */
  readonly bankRuleId: string;
  /**
   * An uncleared statement line on `bankAccountId`, for `getStatementLine`,
   * `proposeBankMatches`, and `clearBankStatementLine` (which posts a journal onto it).
   */
  readonly statementLineId: string;
  /** A cleared statement line, for `removeBankLineClearing` (which reverses its journal). */
  readonly clearedStatementLineId: string;
  /** A ledger account with no bank account yet, for `createBankAccount` to register. */
  readonly registrableBankLedgerAccountId: string;
  /**
   * A `fake` processor connection, for `getProcessorConnection`,
   * `deactivateProcessorConnection`, and `reactivateProcessorConnection` (OB-150).
   * Connected by Owner (`setup`), the way `bankAccountId` is built — the setup
   * context is always Owner regardless of the role under test, so a role that
   * cannot connect a processor still has one to be refused against.
   */
  readonly processorConnectionId: string;
  readonly taxAccountId: string;
  readonly taxRateId: string;
  readonly deletableTaxRateId: string;
  /** Cash application (OB-139): `getPaymentTerm`/`updatePaymentTerm`/`deactivatePaymentTerm`. */
  readonly paymentTermId: string;
  readonly draftInvoiceId: string;
  readonly discardableInvoiceId: string;
  readonly approvableInvoiceId: string;
  readonly voidableInvoiceId: string;
  /** Approved, with room left on it for three allocations. */
  readonly targetInvoiceId: string;
  readonly draftCreditNoteId: string;
  readonly discardableCreditNoteId: string;
  readonly approvableCreditNoteId: string;
  readonly voidableCreditNoteId: string;
  readonly allocatableCreditNoteId: string;
  readonly draftBillId: string;
  readonly discardableBillId: string;
  readonly approvableBillId: string;
  readonly voidableBillId: string;
  readonly targetBillId: string;
  readonly draftVendorCreditId: string;
  readonly discardableVendorCreditId: string;
  readonly approvableVendorCreditId: string;
  readonly voidableVendorCreditId: string;
  readonly allocatableVendorCreditId: string;
  readonly receivedPaymentId: string;
  readonly voidableReceivedPaymentId: string;
  readonly madePaymentId: string;
  readonly voidableMadePaymentId: string;
  readonly allocationId: string;
}

/**
 * One operation, its declared permission, and how to reach it.
 *
 * `operationId` is the route the operation is published as, present so the coverage
 * check below can compare this table against the generated OpenAPI document — the
 * same mechanism `cross-org.test.ts` uses, and for the same reason: a hand-kept
 * list of operations is only as complete as whoever last added a route remembered
 * to make it.
 *
 * OB-067 landed transport for all of M3, so every row that carried `null` for "the
 * service is here before the wire is" now names its route. **Two rows still carry
 * `null`, and they are the same two that did at M2**: `getPeriod` and
 * `getAccountBalances` are reachable from no route at all. A row with a `null`
 * `operationId` is invisible to the coverage check below, which is exactly why the
 * source scan exists as a second axis — it is the one that would notice a service
 * with a gate and neither a route nor a row.
 */
interface Operation {
  readonly name: string;
  readonly operationId: string | null;
  readonly permission: PermissionKey;
  /**
   * Further gates the call reaches **after** its own, in the order it reaches them.
   *
   * M3 is what forced this field, and it is not a convenience. Approving an invoice
   * checks `invoices.write` and then posts through `postJournal`, which checks the
   * caller's own `journals.post` (spec §2.4 — the ledger kernel authorizes its own
   * writes, and OB-062's header argues why a document permission must not stand in
   * for one). A row that declared only the first key would assert that `arOnly` may
   * approve an invoice, which is false, and the reason it is false is the finding
   * this milestone produced.
   *
   * The declared `permission` stays the *first* gate, so the `nobody` pass below is
   * unaffected: a role holding nothing is refused before anything downstream runs.
   */
  readonly thenRequires?: readonly PermissionKey[];
  readonly call: (scene: Scene) => Promise<unknown>;
}

/** Every key a call is gated on, in the order the call reaches them. */
function gatesOf(operation: Operation): readonly PermissionKey[] {
  return [operation.permission, ...(operation.thenRequires ?? [])];
}

const OPERATIONS: readonly Operation[] = [
  {
    name: 'createAccount',
    operationId: 'createAccount',
    permission: 'accounts.write',
    call: (s) =>
      createAccount(
        { code: '9100', name: 'Sundry', type: 'expense', normalBalance: 'debit' },
        s.ctx,
      ),
  },
  {
    name: 'getAccount',
    operationId: 'getAccount',
    permission: 'accounts.read',
    call: (s) => getAccount(s.cashId, s.ctx),
  },
  {
    name: 'listAccounts',
    operationId: 'listAccounts',
    permission: 'accounts.read',
    call: (s) => listAccounts({}, s.ctx),
  },
  {
    name: 'updateAccount',
    operationId: 'updateAccount',
    permission: 'accounts.write',
    call: (s) => updateAccount(s.cashId, { name: 'Cash at bank' }, s.ctx),
  },
  {
    name: 'deactivateAccount',
    operationId: 'deactivateAccount',
    permission: 'accounts.write',
    call: (s) => deactivateAccount(s.cashId, s.ctx),
  },
  {
    name: 'reactivateAccount',
    operationId: 'reactivateAccount',
    permission: 'accounts.write',
    call: (s) => reactivateAccount(s.cashId, s.ctx),
  },
  {
    name: 'deleteAccount',
    operationId: 'deleteAccount',
    permission: 'accounts.write',
    call: (s) => deleteAccount(s.cashId, s.ctx),
  },
  {
    name: 'listChartTemplates',
    operationId: 'listChartTemplates',
    permission: 'accounts.read',
    call: (s) => listChartTemplates(s.ctx),
  },
  {
    name: 'applyChartTemplate',
    operationId: 'applyChartTemplate',
    permission: 'accounts.write',
    call: (s) => applyChartTemplate({ templateId: 'general_small_business' }, s.ctx),
  },
  {
    name: 'createContact',
    operationId: 'createContact',
    permission: 'contacts.write',
    call: (s) => createContact({ displayName: 'Globex' }, s.ctx),
  },
  {
    name: 'getContact',
    operationId: 'getContact',
    permission: 'contacts.read',
    call: (s) => getContact(s.contactId, s.ctx),
  },
  {
    name: 'listContacts',
    operationId: 'listContacts',
    permission: 'contacts.read',
    call: (s) => listContacts({}, s.ctx),
  },
  {
    name: 'updateContact',
    operationId: 'updateContact',
    permission: 'contacts.write',
    call: (s) => updateContact(s.contactId, { displayName: 'Acme Inc' }, s.ctx),
  },
  {
    name: 'deactivateContact',
    operationId: 'deactivateContact',
    permission: 'contacts.write',
    call: (s) => deactivateContact(s.contactId, s.ctx),
  },
  {
    name: 'reactivateContact',
    operationId: 'reactivateContact',
    permission: 'contacts.write',
    call: (s) => reactivateContact(s.contactId, s.ctx),
  },
  {
    name: 'deleteContact',
    operationId: 'deleteContact',
    permission: 'contacts.write',
    call: (s) => deleteContact(s.contactId, s.ctx),
  },
  {
    name: 'createDimension',
    operationId: 'createDimension',
    permission: 'dimensions.write',
    call: (s) => createDimension({ code: 'REGION', name: 'Region' }, s.ctx),
  },
  {
    name: 'getDimension',
    operationId: 'getDimension',
    permission: 'dimensions.read',
    call: (s) => getDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'listDimensions',
    operationId: 'listDimensions',
    permission: 'dimensions.read',
    call: (s) => listDimensions({}, s.ctx),
  },
  {
    name: 'updateDimension',
    operationId: 'updateDimension',
    permission: 'dimensions.write',
    call: (s) => updateDimension(s.dimensionId, { name: 'Cost centre' }, s.ctx),
  },
  {
    name: 'archiveDimension',
    operationId: 'archiveDimension',
    permission: 'dimensions.write',
    call: (s) => archiveDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'unarchiveDimension',
    operationId: 'unarchiveDimension',
    permission: 'dimensions.write',
    call: (s) => unarchiveDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'createDimensionValue',
    operationId: 'createDimensionValue',
    permission: 'dimensions.write',
    call: (s) => createDimensionValue(s.dimensionId, { code: 'OPS', name: 'Operations' }, s.ctx),
  },
  {
    name: 'getDimensionValue',
    operationId: 'getDimensionValue',
    permission: 'dimensions.read',
    call: (s) => getDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'listDimensionValues',
    operationId: 'listDimensionValues',
    permission: 'dimensions.read',
    call: (s) => listDimensionValues(s.dimensionId, {}, s.ctx),
  },
  {
    name: 'updateDimensionValue',
    operationId: 'updateDimensionValue',
    permission: 'dimensions.write',
    call: (s) => updateDimensionValue(s.dimensionValueId, { name: 'Sales team' }, s.ctx),
  },
  {
    name: 'archiveDimensionValue',
    operationId: 'archiveDimensionValue',
    permission: 'dimensions.write',
    call: (s) => archiveDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'unarchiveDimensionValue',
    operationId: 'unarchiveDimensionValue',
    permission: 'dimensions.write',
    call: (s) => unarchiveDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'deleteDimensionValue',
    operationId: 'deleteDimensionValue',
    permission: 'dimensions.write',
    call: (s) => deleteDimensionValue(s.dimensionValueId, s.ctx),
  },
  {
    name: 'deleteDimension',
    operationId: 'deleteDimension',
    permission: 'dimensions.write',
    call: (s) => deleteDimension(s.dimensionId, s.ctx),
  },
  {
    name: 'getJournalLineDimensions',
    operationId: 'getJournalLineDimensions',
    permission: 'dimensions.read',
    call: (s) => getJournalLineDimensions(s.journalLineId, s.ctx),
  },
  {
    name: 'setJournalLineDimensions',
    operationId: 'setJournalLineDimensions',
    permission: 'dimensions.write',
    call: (s) => setJournalLineDimensions(s.journalLineId, { valueIds: [] }, s.ctx),
  },
  {
    name: 'createDraft',
    operationId: 'createDraft',
    permission: 'journals.post',
    call: (s) => createDraft({ entryDate: s.date, memo: 'Proposal' }, s.ctx),
  },
  {
    name: 'getDraft',
    operationId: 'getDraft',
    permission: 'journals.read',
    call: (s) => getDraft(s.draftId, s.ctx),
  },
  {
    name: 'listDrafts',
    operationId: 'listDrafts',
    permission: 'journals.read',
    call: (s) => listDrafts({}, s.ctx),
  },
  {
    name: 'updateDraft',
    operationId: 'updateDraft',
    permission: 'journals.post',
    call: (s) => updateDraft(s.draftId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'postDraft',
    operationId: 'postDraft',
    permission: 'journals.post',
    call: (s) => postDraft(s.draftId, s.ctx),
  },
  // A second draft, because `postDraft` above consumes the first (D-19).
  {
    name: 'discardDraft',
    operationId: 'discardDraft',
    permission: 'journals.post',
    call: (s) => discardDraft(s.discardableDraftId, s.ctx),
  },
  {
    name: 'postJournal',
    operationId: 'postJournal',
    permission: 'journals.post',
    call: (s) =>
      postJournal(
        {
          date: s.date,
          actorType: 'user',
          actorId: s.actorId,
          lines: [
            { accountId: s.cashId, side: 'debit', amount: 5000n },
            { accountId: s.revenueId, side: 'credit', amount: 5000n },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'reverseJournal',
    operationId: 'reverseJournal',
    permission: 'journals.reverse',
    call: (s) =>
      reverseJournal(
        { journalId: s.journalId, date: s.date, actorType: 'user', actorId: s.actorId },
        s.ctx,
      ),
  },
  {
    name: 'listJournals',
    operationId: 'listJournals',
    permission: 'journals.read',
    call: (s) => listJournals({}, s.ctx),
  },
  {
    name: 'listMembers',
    operationId: 'listMembers',
    permission: 'members.read',
    call: (s) => listMembers(s.ctx),
  },
  {
    name: 'listAssignableRoles',
    operationId: 'listAssignableRoles',
    permission: 'roles.read',
    call: (s) => listAssignableRoles(s.ctx),
  },
  {
    name: 'changeMemberRole',
    operationId: 'changeMemberRole',
    permission: 'members.write',
    call: (s) =>
      changeMemberRole({ userId: s.otherUserId, roleId: SYSTEM_ROLE_UUIDS.readOnly }, s.ctx),
  },
  {
    name: 'removeMember',
    operationId: 'removeMember',
    permission: 'members.write',
    call: (s) => removeMember({ userId: s.otherUserId }, s.ctx),
  },
  {
    name: 'inviteMember',
    operationId: 'inviteMember',
    permission: 'members.write',
    call: (s) =>
      inviteMember(
        { email: `invited-${s.orgUuid}@openbooks.test`, roleId: SYSTEM_ROLE_UUIDS.bookkeeper },
        s.ctx,
      ),
  },
  {
    name: 'listInvites',
    operationId: 'listInvites',
    permission: 'members.read',
    call: (s) => listInvites(s.ctx),
  },
  {
    name: 'revokeInvite',
    operationId: 'revokeInvite',
    permission: 'members.write',
    call: (s) => revokeInvite({ inviteId: s.inviteId }, s.ctx),
  },
  {
    name: 'generateFiscalYear',
    operationId: 'generateFiscalYear',
    permission: 'periods.write',
    call: () => generateFiscalYear({ fiscalYear: 2027 }),
  },
  {
    name: 'createPeriod',
    operationId: 'createFiscalPeriod',
    permission: 'periods.write',
    call: () => createPeriod({ year: 2028, month: 6 }),
  },
  {
    name: 'listPeriods',
    operationId: 'listFiscalPeriods',
    permission: 'periods.read',
    call: () => listPeriods({}),
  },
  {
    name: 'closePeriod',
    operationId: 'closeFiscalPeriod',
    permission: 'periods.close',
    call: (s) => closePeriod({ periodId: s.periodId }),
  },
  {
    name: 'reopenPeriod',
    operationId: 'reopenFiscalPeriod',
    permission: 'periods.reopen',
    call: (s) => reopenPeriod({ periodId: s.periodId }),
  },
  // P (OB-193): the advisory close checklist is a read gated on `periods.read` — a
  // side-effect-free preview of what a close would record.
  {
    name: 'getPeriodCloseChecklist',
    operationId: 'getPeriodCloseChecklist',
    permission: 'periods.read',
    call: (s) => computeCloseChecklist({ periodId: s.periodId }, s.ctx),
  },
  /**
   * No route. `getPeriod` is the read a future period-detail screen is built on,
   * so it is in the matrix before it is on the wire — the alternative is that its
   * first authorization check is written by whoever adds the route.
   */
  {
    name: 'getPeriod',
    operationId: null,
    permission: 'periods.read',
    call: (s) => getPeriod({ periodId: s.periodId }),
  },
  {
    name: 'getTrialBalance',
    operationId: 'getTrialBalance',
    permission: 'reports.read',
    call: (s) => getTrialBalance({}, s.ctx),
  },
  {
    name: 'getProfitAndLoss',
    operationId: 'getProfitAndLoss',
    permission: 'reports.read',
    call: (s) => getProfitAndLoss({}, s.ctx),
  },
  {
    name: 'getBalanceSheet',
    operationId: 'getBalanceSheet',
    permission: 'reports.read',
    call: (s) => getBalanceSheet({ asOf: s.date }, s.ctx),
  },
  {
    name: 'getGeneralLedger',
    operationId: 'getGeneralLedger',
    permission: 'reports.read',
    call: (s) => getGeneralLedger({ accountId: s.cashId }, s.ctx),
  },
  // K (cash-basis reporting): the two cash-flow statements (OB-157, OB-158), each a
  // read gated on `reports.read` like every other report.
  {
    name: 'getStatementOfCashFlows',
    operationId: 'getStatementOfCashFlows',
    permission: 'reports.read',
    call: (s) => getStatementOfCashFlows({}, s.ctx),
  },
  {
    name: 'getCashFlowProjection',
    operationId: 'getCashFlowProjection',
    permission: 'reports.read',
    call: (s) => getCashFlowProjection({}, s.ctx),
  },
  // P (OB-195, OB-196): the statement package renders reports the `reports.read`
  // holder can already run, so it gates on `reports.read` and adds no new key. The
  // audit report gates on the new `audit.read` — it exposes activity across the org,
  // a capability distinct from any single figure (D-98).
  {
    name: 'createStatementPackage',
    operationId: 'createStatementPackage',
    permission: 'reports.read',
    call: (s) => createStatementPackage({ periodStart: s.date, periodEnd: s.date }, s.ctx),
  },
  {
    name: 'listStatementPackages',
    operationId: 'listStatementPackages',
    permission: 'reports.read',
    call: (s) => listStatementPackages(s.ctx),
  },
  {
    name: 'getAuditReport',
    operationId: 'getAuditReport',
    permission: 'audit.read',
    call: (s) => getAuditReport({ limit: 50 }, s.ctx),
  },
  /**
   * No route either — the report *core* every projection above is assembled from.
   * It carries its own `requirePermission` rather than trusting its callers, and
   * this row is what says so.
   */
  {
    name: 'getAccountBalances',
    operationId: null,
    permission: 'reports.read',
    call: (s) => getAccountBalances({}, s.ctx),
  },
  /**
   * Aging (OB-065). `reports.read` and only that, which is the decision
   * `aging.service.ts` argues at length: `ap_only` already holds `reports.read` and
   * `journals.read`, so it can read the receivables control account's general
   * ledger contact by contact, and adding `invoices.read` here would gate a report
   * on a boundary the caller can already walk around. The row exists so that
   * argument is asserted rather than only written down — if a second check is ever
   * added, this row fails and whoever added it has to come here.
   */
  {
    name: 'getAging',
    operationId: 'getAging',
    permission: 'reports.read',
    call: (s) => getAging({ asOf: s.date, ledger: 'receivable' }, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // M3 — AR documents (OB-062), on the wire since OB-067.
  //
  // Every row here carried `null` for one milestone-quarter, and the ids it carries
  // now were filled in by reading `src/transport/routes/`, not by assuming the
  // route was named after the service. Two of the four AR transitions are the
  // reason to check rather than assume: `approveInvoice` is `POST …/approve` and
  // `discardInvoice` is `DELETE …`, so neither operation id could have been
  // guessed from the HTTP method.
  // ---------------------------------------------------------------------------

  {
    name: 'createInvoice',
    operationId: 'createInvoice',
    permission: 'invoices.write',
    call: (s) =>
      createInvoice(
        { contactId: s.partyId, issueDate: s.date, taxMode: 'exclusive', lines: [arLine(s)] },
        s.ctx,
      ),
  },
  {
    name: 'getInvoice',
    operationId: 'getInvoice',
    permission: 'invoices.read',
    call: (s) => getInvoice(s.targetInvoiceId, s.ctx),
  },
  {
    name: 'listInvoices',
    operationId: 'listInvoices',
    permission: 'invoices.read',
    call: (s) => listInvoices({}, s.ctx),
  },
  {
    name: 'updateInvoice',
    operationId: 'updateInvoice',
    permission: 'invoices.write',
    call: (s) => updateInvoice(s.draftInvoiceId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'discardInvoice',
    operationId: 'discardInvoice',
    permission: 'invoices.write',
    call: (s) => discardInvoice(s.discardableInvoiceId, s.ctx),
  },
  {
    name: 'approveInvoice',
    operationId: 'approveInvoice',
    permission: 'invoices.write',
    thenRequires: ['journals.post'],
    call: (s) => approveInvoice(s.approvableInvoiceId, s.ctx),
  },
  {
    name: 'voidInvoice',
    operationId: 'voidInvoice',
    permission: 'invoices.void',
    thenRequires: ['journals.reverse'],
    call: (s) => voidInvoice(s.voidableInvoiceId, { date: s.date }, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // INV (Phase 1) — branding and invoice delivery. `invoices.send` has no
  // `thenRequires`: sending posts no journal. These rows exercise the *gate*, not
  // the send — the call is judged `allowed` the moment `requirePermission` passes,
  // so a downstream miss (an absent invoice, an unconfigured store) is `allowed`
  // for a holder, which is exactly the verdict the seeds predict. `sendInvoice`
  // names a fresh id on purpose: a holder 404s past its one gate (there is no
  // second gate a false `allowed` could hide), a non-holder is refused first.
  // ---------------------------------------------------------------------------
  {
    name: 'getBranding',
    operationId: 'getBranding',
    permission: 'branding.read',
    call: (s) => getBranding(s.ctx),
  },
  {
    name: 'updateBranding',
    operationId: 'updateBranding',
    permission: 'branding.write',
    call: (s) => updateBranding({ displayName: 'Rebranded Co' }, s.ctx),
  },
  {
    name: 'uploadBrandingLogo',
    operationId: 'uploadBrandingLogo',
    permission: 'branding.write',
    call: (s) => uploadLogo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png', s.ctx),
  },
  {
    name: 'sendInvoice',
    operationId: 'sendInvoice',
    permission: 'invoices.send',
    call: (s) => sendInvoice(newUuid(), {}, s.ctx),
  },

  {
    name: 'createCreditNote',
    operationId: 'createCreditNote',
    permission: 'credit_notes.write',
    call: (s) =>
      createCreditNote(
        { contactId: s.partyId, issueDate: s.date, taxMode: 'exclusive', lines: [arLine(s)] },
        s.ctx,
      ),
  },
  {
    name: 'getCreditNote',
    operationId: 'getCreditNote',
    permission: 'credit_notes.read',
    call: (s) => getCreditNote(s.allocatableCreditNoteId, s.ctx),
  },
  {
    name: 'listCreditNotes',
    operationId: 'listCreditNotes',
    permission: 'credit_notes.read',
    call: (s) => listCreditNotes({}, s.ctx),
  },
  {
    name: 'updateCreditNote',
    operationId: 'updateCreditNote',
    permission: 'credit_notes.write',
    call: (s) => updateCreditNote(s.draftCreditNoteId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'discardCreditNote',
    operationId: 'discardCreditNote',
    permission: 'credit_notes.write',
    call: (s) => discardCreditNote(s.discardableCreditNoteId, s.ctx),
  },
  {
    name: 'approveCreditNote',
    operationId: 'approveCreditNote',
    permission: 'credit_notes.write',
    thenRequires: ['journals.post'],
    call: (s) => approveCreditNote(s.approvableCreditNoteId, s.ctx),
  },
  /**
   * `credit_notes.write`, not a `credit_notes.void` — the catalog holds no such
   * code. Declared here rather than assumed, so the day one is seeded this row is
   * one of the two places that has to change.
   */
  {
    name: 'voidCreditNote',
    operationId: 'voidCreditNote',
    permission: 'credit_notes.write',
    thenRequires: ['journals.reverse'],
    call: (s) => voidCreditNote(s.voidableCreditNoteId, { date: s.date }, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // M3 — AP documents (OB-063).
  // ---------------------------------------------------------------------------

  {
    name: 'createBill',
    operationId: 'createBill',
    permission: 'bills.write',
    call: (s) =>
      createBill(
        {
          contactId: s.partyId,
          issueDate: s.date,
          dueDate: s.date,
          taxMode: 'exclusive',
          lines: [apLine(s)],
        },
        s.ctx,
      ),
  },
  {
    name: 'getBill',
    operationId: 'getBill',
    permission: 'bills.read',
    call: (s) => getBill(s.targetBillId, s.ctx),
  },
  {
    name: 'listBills',
    operationId: 'listBills',
    permission: 'bills.read',
    call: (s) => listBills({}, s.ctx),
  },
  {
    name: 'updateBill',
    operationId: 'updateBill',
    permission: 'bills.write',
    call: (s) => updateBill(s.draftBillId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'discardBill',
    operationId: 'discardBill',
    permission: 'bills.write',
    call: (s) => discardBill(s.discardableBillId, s.ctx),
  },
  /**
   * `bills.write`, because the catalog holds no `bills.approve` — the same shape as
   * `voidCreditNote` above and the mirror image of it. AP has a `void` code and no
   * `approve`; AR's credit notes have an `approve`-by-`write` and no `void`.
   * Neither asymmetry is defensible on its own terms; both are what spec §5's fixed
   * catalog says, and both are asserted below.
   */
  {
    name: 'approveBill',
    operationId: 'approveBill',
    permission: 'bills.write',
    thenRequires: ['journals.post'],
    call: (s) => approveBill(s.approvableBillId, s.ctx),
  },
  {
    name: 'voidBill',
    operationId: 'voidBill',
    permission: 'bills.void',
    thenRequires: ['journals.reverse'],
    call: (s) => voidBill(s.voidableBillId, { date: s.date }, s.ctx),
  },
  /**
   * Bill capture (initiative O). Every capture operation reuses the AP document
   * codes — capturing a bill is writing a bill, so no `captures.*` code exists
   * (the pinned decision). `bills.write` for the writes, `bills.read` for the reads,
   * with `requirePermission` the first line of each service function, so a non-holder
   * is refused at the gate before any capture id is loaded (a holder may 404 past it
   * on the `newUuid()` ids and still read `allowed`, which is the shape every id-based
   * row above relies on). `getInboundEmailAddress` takes `bills.write` because it
   * lazily mints the org's inbound token — a genuine first write. The inbound webhook
   * itself (`receiveInboundBill`) carries no gate and is in `UNGATED_OPERATIONS`.
   */
  {
    name: 'createBillCapture',
    operationId: 'createBillCapture',
    permission: 'bills.write',
    call: (s) =>
      createCaptureFromUpload(
        {
          filename: 'bill.pdf',
          contentType: 'application/pdf',
          content: Buffer.from('vendor: Acme', 'utf8').toString('base64'),
        },
        s.ctx,
      ),
  },
  {
    name: 'listBillCaptures',
    operationId: 'listBillCaptures',
    permission: 'bills.read',
    call: (s) => listCaptures({}, s.ctx),
  },
  {
    name: 'getBillCapture',
    operationId: 'getBillCapture',
    permission: 'bills.read',
    call: (s) => getCapture(newUuid(), s.ctx),
  },
  {
    name: 'dismissBillCapture',
    operationId: 'dismissBillCapture',
    permission: 'bills.write',
    call: (s) => dismissCapture(newUuid(), s.ctx),
  },
  {
    name: 'createDraftFromBillCapture',
    operationId: 'createDraftFromBillCapture',
    permission: 'bills.write',
    call: (s) =>
      createDraftFromCapture(
        newUuid(),
        {
          contactId: s.partyId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [apLine(s)],
        },
        s.ctx,
      ),
  },
  {
    name: 'getBillAttachment',
    operationId: 'getBillAttachment',
    permission: 'bills.read',
    call: (s) => getBillAttachment(newUuid(), newUuid(), s.ctx),
  },
  {
    name: 'getInboundBillEmailAddress',
    operationId: 'getInboundBillEmailAddress',
    permission: 'bills.write',
    call: (s) => getInboundEmailAddress(s.ctx),
  },
  {
    name: 'createVendorCredit',
    operationId: 'createVendorCredit',
    permission: 'vendor_credits.write',
    call: (s) =>
      createVendorCredit(
        { contactId: s.partyId, issueDate: s.date, taxMode: 'exclusive', lines: [apLine(s)] },
        s.ctx,
      ),
  },
  {
    name: 'getVendorCredit',
    operationId: 'getVendorCredit',
    permission: 'vendor_credits.read',
    call: (s) => getVendorCredit(s.allocatableVendorCreditId, s.ctx),
  },
  {
    name: 'listVendorCredits',
    operationId: 'listVendorCredits',
    permission: 'vendor_credits.read',
    call: (s) => listVendorCredits({}, s.ctx),
  },
  {
    name: 'updateVendorCredit',
    operationId: 'updateVendorCredit',
    permission: 'vendor_credits.write',
    call: (s) => updateVendorCredit(s.draftVendorCreditId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'discardVendorCredit',
    operationId: 'discardVendorCredit',
    permission: 'vendor_credits.write',
    call: (s) => discardVendorCredit(s.discardableVendorCreditId, s.ctx),
  },
  {
    name: 'approveVendorCredit',
    operationId: 'approveVendorCredit',
    permission: 'vendor_credits.write',
    thenRequires: ['journals.post'],
    call: (s) => approveVendorCredit(s.approvableVendorCreditId, s.ctx),
  },
  {
    name: 'voidVendorCredit',
    operationId: 'voidVendorCredit',
    permission: 'vendor_credits.write',
    thenRequires: ['journals.reverse'],
    call: (s) => voidVendorCredit(s.voidableVendorCreditId, { date: s.date }, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // M3 — payments and allocation (OB-064).
  //
  // Both directions are listed rather than one, because the direction *is* the
  // authorization: `payments.service.ts` reads the payment's own direction and then
  // checks one of two codes. A matrix carrying only the received side would leave
  // `payments_made.*` declared and never exercised, which is exactly the vacuity
  // the `nobody` pass exists to prevent.
  //
  // OB-067 published one route per operation rather than one per direction, so the
  // eight rows below name four operation ids between them. See
  // `DIRECTION_SPLIT_OPERATIONS`, which is what keeps that from being a silent
  // deduplication.
  // ---------------------------------------------------------------------------

  {
    name: 'recordPaymentReceived',
    operationId: 'recordPayment',
    permission: 'payments_received.write',
    thenRequires: ['journals.post'],
    call: (s) =>
      recordPayment(
        {
          direction: 'received',
          contactId: s.partyId,
          date: s.date,
          amount: '5000',
          accountId: s.bankId,
        },
        s.ctx,
      ),
  },
  {
    name: 'getPaymentReceived',
    operationId: 'getPayment',
    permission: 'payments_received.read',
    call: (s) => getPayment(s.receivedPaymentId, s.ctx),
  },
  {
    name: 'updatePaymentReceived',
    operationId: 'updatePayment',
    permission: 'payments_received.write',
    call: (s) => updatePayment(s.receivedPaymentId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'voidPaymentReceived',
    operationId: 'voidPayment',
    permission: 'payments_received.write',
    thenRequires: ['journals.reverse'],
    call: (s) => voidPayment(s.voidableReceivedPaymentId, { date: s.date }, s.ctx),
  },
  {
    name: 'recordPaymentMade',
    operationId: 'recordPayment',
    permission: 'payments_made.write',
    thenRequires: ['journals.post'],
    call: (s) =>
      recordPayment(
        {
          direction: 'made',
          contactId: s.partyId,
          date: s.date,
          amount: '5000',
          accountId: s.bankId,
        },
        s.ctx,
      ),
  },
  {
    name: 'getPaymentMade',
    operationId: 'getPayment',
    permission: 'payments_made.read',
    call: (s) => getPayment(s.madePaymentId, s.ctx),
  },
  {
    name: 'updatePaymentMade',
    operationId: 'updatePayment',
    permission: 'payments_made.write',
    call: (s) => updatePayment(s.madePaymentId, { memo: 'Edited' }, s.ctx),
  },
  {
    name: 'voidPaymentMade',
    operationId: 'voidPayment',
    permission: 'payments_made.write',
    thenRequires: ['journals.reverse'],
    call: (s) => voidPayment(s.voidableMadePaymentId, { date: s.date }, s.ctx),
  },
  /**
   * The one operation in the system that needs **both** halves of a pair.
   *
   * An unfiltered list spans both subledgers, so `listPayments` requires the
   * authority to read both rather than silently returning the caller's own side —
   * the service's own commentary argues that a filtered result would turn a missing
   * permission into an empty page nobody can distinguish from real emptiness. So an
   * AR clerk is refused with `payments_made.read`, which is the key naming what they
   * are actually missing.
   */
  {
    name: 'listPayments',
    operationId: 'listPayments',
    permission: 'payments_received.read',
    thenRequires: ['payments_made.read'],
    call: (s) => listPayments({}, s.ctx),
  },
  {
    name: 'allocatePayment',
    operationId: 'allocatePayment',
    permission: 'payments_received.write',
    call: (s) =>
      allocatePayment(
        s.receivedPaymentId,
        { allocations: [{ targetType: 'invoice', targetId: s.targetInvoiceId, amount: '10000' }] },
        s.ctx,
      ),
  },
  {
    name: 'allocateCreditNote',
    operationId: 'allocateCreditNote',
    permission: 'credit_notes.write',
    call: (s) =>
      allocateCreditNote(
        s.allocatableCreditNoteId,
        { allocations: [{ targetType: 'invoice', targetId: s.targetInvoiceId, amount: '10000' }] },
        s.ctx,
      ),
  },
  {
    name: 'allocateVendorCredit',
    operationId: 'allocateVendorCredit',
    permission: 'vendor_credits.write',
    call: (s) =>
      allocateVendorCredit(
        s.allocatableVendorCreditId,
        { allocations: [{ targetType: 'bill', targetId: s.targetBillId, amount: '10000' }] },
        s.ctx,
      ),
  },
  /**
   * Un-applying takes the *source's* write permission, and the fixture is an
   * allocation made by a received payment — so this row is `payments_received.write`
   * rather than an allocation code of its own. Nothing posts here (D-37), which is
   * why there is no `thenRequires`: an allocation moved no money, so removing one
   * restates nothing and needs no ledger authority.
   */
  {
    name: 'deleteAllocation',
    operationId: 'deleteAllocation',
    permission: 'payments_received.write',
    call: (s) => deleteAllocation(s.allocationId, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // M3 — tax rates (OB-066). Configuration, not documents, which is why neither
  // clerk holds the write.
  // ---------------------------------------------------------------------------

  {
    name: 'createTaxRate',
    operationId: 'createTaxRate',
    permission: 'tax_rates.write',
    call: (s) =>
      createTaxRate({ name: 'Sales tax 5%', percentage: '5', accountId: s.taxAccountId }, s.ctx),
  },
  {
    name: 'getTaxRate',
    operationId: 'getTaxRate',
    permission: 'tax_rates.read',
    call: (s) => getTaxRate(s.taxRateId, s.ctx),
  },
  {
    name: 'listTaxRates',
    operationId: 'listTaxRates',
    permission: 'tax_rates.read',
    call: (s) => listTaxRates({}, s.ctx),
  },
  {
    name: 'updateTaxRate',
    operationId: 'updateTaxRate',
    permission: 'tax_rates.write',
    call: (s) => updateTaxRate(s.taxRateId, { name: 'VAT (standard)' }, s.ctx),
  },
  {
    name: 'archiveTaxRate',
    operationId: 'archiveTaxRate',
    permission: 'tax_rates.write',
    call: (s) => archiveTaxRate(s.taxRateId, s.ctx),
  },
  {
    name: 'unarchiveTaxRate',
    operationId: 'unarchiveTaxRate',
    permission: 'tax_rates.write',
    call: (s) => unarchiveTaxRate(s.taxRateId, s.ctx),
  },
  // A second rate, because no document cites it — `deleteTaxRate` is refused for
  // one that is cited, and a refusal on those grounds would read `allowed`.
  {
    name: 'deleteTaxRate',
    operationId: 'deleteTaxRate',
    permission: 'tax_rates.write',
    call: (s) => deleteTaxRate(s.deletableTaxRateId, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // M3 — the org's control-account nominations (`modules/settings`).
  //
  // Last in the list on purpose: `updateControlAccounts` decides where every
  // approval above posts, so a row that repointed it earlier would change what the
  // rows after it were judged on. It repoints to the accounts already nominated,
  // which exercises the gate and moves nothing.
  // ---------------------------------------------------------------------------

  {
    name: 'getControlAccounts',
    operationId: 'getControlAccounts',
    permission: 'orgs.read',
    call: (s) => getControlAccounts(s.ctx),
  },
  {
    name: 'updateControlAccounts',
    operationId: 'updateControlAccounts',
    permission: 'orgs.write',
    call: (s) =>
      updateControlAccounts(
        {
          receivableControlAccountId: s.receivableId,
          payableControlAccountId: s.payableId,
        },
        s.ctx,
      ),
  },
  // ---------------------------------------------------------------------------
  // M4 (OB-084). Every banking operation the wire publishes, gated by the five
  // banking codes waves 1–3 wired live. The verdict turns on the *first* gate:
  // `judge` reads a `permission_denied` and nothing else, so a permitted role's call
  // may 404 or precondition-fail past its gate and still read `allowed` — the reason
  // a read row needs the resource it names to exist, and a write row a real target.
  //
  // Three rows gate `banking.read` from a `POST` (`previewBankStatementImport`,
  // `proposeBankMatches`) or a start (`startBankStatementImport`); those services
  // parse before they check permission, so the input is kept valid — otherwise a
  // `validation_failed` would reach `judge` as `allowed` and hide the gate.
  // ---------------------------------------------------------------------------

  {
    name: 'createBankAccount',
    operationId: 'createBankAccount',
    permission: 'banking.import',
    call: (s) =>
      createBankAccount(
        { accountId: s.registrableBankLedgerAccountId, name: 'New account' },
        s.ctx,
      ),
  },
  {
    name: 'listBankAccounts',
    operationId: 'listBankAccounts',
    permission: 'banking.read',
    call: (s) => listBankAccounts({}, s.ctx),
  },
  {
    name: 'getBankAccount',
    operationId: 'getBankAccount',
    permission: 'banking.read',
    call: (s) => getBankAccount(s.bankAccountId, s.ctx),
  },
  {
    name: 'updateBankAccount',
    operationId: 'updateBankAccount',
    permission: 'banking.import',
    call: (s) => updateBankAccount(s.bankAccountId, { name: 'Renamed' }, s.ctx),
  },
  // `s.bankAccountId` carries no open reconciliation session at this point in the pass —
  // `createReconciliationSession` opens one later — so a permitted role's deactivation
  // reaches past the gate and succeeds, and reactivate restores the account before the
  // rows below touch it. `banking.import` is already enforced (register/update), so no
  // `GRANTED_TO`/`LATENT_GRANTS` change accompanies these two.
  {
    name: 'deactivateBankAccount',
    operationId: 'deactivateBankAccount',
    permission: 'banking.import',
    call: (s) => deactivateBankAccount(s.bankAccountId, s.ctx),
  },
  {
    name: 'reactivateBankAccount',
    operationId: 'reactivateBankAccount',
    permission: 'banking.import',
    call: (s) => reactivateBankAccount(s.bankAccountId, s.ctx),
  },
  {
    name: 'previewBankStatementImport',
    operationId: 'previewBankStatementImport',
    permission: 'banking.read',
    call: (s) =>
      previewImportWithParsers(
        {
          bankAccountId: s.bankAccountId,
          format: 'csv',
          filename: 'march.csv',
          content: 'date,description,amount\n2026-01-01,COFFEE,-4.50\n',
          mapping: {
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
        s.ctx,
      ),
  },
  {
    name: 'startBankStatementImport',
    operationId: 'startBankStatementImport',
    permission: 'banking.import',
    call: (s) =>
      startImport(
        {
          bankAccountId: s.bankAccountId,
          format: 'csv',
          filename: 'march.csv',
          content: 'date,description,amount\n2026-01-01,COFFEE,-4.50\n',
          mapping: {
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
        s.ctx,
      ),
  },
  {
    name: 'listBankStatementImports',
    operationId: 'listBankStatementImports',
    permission: 'banking.read',
    call: (s) => listBankStatementImports({}, s.ctx),
  },
  {
    name: 'getBankStatementImport',
    operationId: 'getBankStatementImport',
    permission: 'banking.read',
    call: (s) => getBankStatementImport(s.bankImportId, s.ctx),
  },
  {
    name: 'saveBankImportMapping',
    operationId: 'saveBankImportMapping',
    permission: 'banking.import',
    call: (s) =>
      saveBankImportMapping(
        s.bankAccountId,
        {
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
        },
        s.ctx,
      ),
  },
  {
    name: 'listBankImportMappings',
    operationId: 'listBankImportMappings',
    permission: 'banking.read',
    call: (s) => listBankImportMappings(s.bankAccountId, {}, s.ctx),
  },
  // The QuickBooks cutover checks its permissions upfront and unconditionally (a single
  // operation that creates accounts, contacts and — with a trial balance — a journal, so it
  // requires the union). `journals.post` is gated even on a lists-only run; `periods.write` is
  // reached only on the fiscal-year branch a trial balance can trigger, so it is not declared
  // here and this call sends no trial balance.
  {
    name: 'previewQuickBooksImport',
    operationId: 'previewQuickBooksImport',
    permission: 'accounts.read',
    thenRequires: ['contacts.read'],
    call: (s) =>
      previewQuickBooksImport(
        { asOfDate: '2026-01-15', accounts: 'Name,Type\nCash,Bank\n' },
        s.ctx,
      ),
  },
  {
    name: 'importQuickBooks',
    operationId: 'importQuickBooks',
    permission: 'accounts.write',
    thenRequires: ['contacts.write', 'journals.post'],
    call: (s) =>
      importQuickBooks({ asOfDate: '2026-01-15', accounts: 'Name,Type\nCash,Bank\n' }, s.ctx),
  },
  // Phase 4 — recurring invoices and dunning. Every write shares `invoices.*` (a template is a
  // standing instruction to raise an invoice, a policy governs sending), and none declares a
  // `thenRequires`: creating a template writes only the template (materialisation posts later,
  // in the engine, not in this call), creating a policy writes only the policy, and the manual
  // run only enqueues. The id-addressed calls pass a fresh uuid — the gate is checked before the
  // row is loaded, so a not-found is `judge`'d as allowed for a role that clears the gate.
  {
    name: 'createRecurringInvoiceTemplate',
    operationId: 'createRecurringInvoiceTemplate',
    permission: 'invoices.write',
    call: (s) =>
      createRecurringInvoiceTemplate(
        {
          contactId: s.contactId,
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
              accountId: s.revenueId,
              taxRateId: null,
            },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'listRecurringInvoiceTemplates',
    operationId: 'listRecurringInvoiceTemplates',
    permission: 'invoices.read',
    call: (s) => listRecurringInvoiceTemplates({}, s.ctx),
  },
  {
    name: 'getRecurringInvoiceTemplate',
    operationId: 'getRecurringInvoiceTemplate',
    permission: 'invoices.read',
    call: (s) => getRecurringInvoiceTemplate(newUuid(), s.ctx),
  },
  {
    name: 'updateRecurringInvoiceTemplate',
    operationId: 'updateRecurringInvoiceTemplate',
    permission: 'invoices.write',
    call: (s) => updateRecurringInvoiceTemplate(newUuid(), { name: 'Edited' }, s.ctx),
  },
  {
    name: 'deactivateRecurringInvoiceTemplate',
    operationId: 'deactivateRecurringInvoiceTemplate',
    permission: 'invoices.write',
    call: (s) => deactivateRecurringInvoiceTemplate(newUuid(), s.ctx),
  },
  {
    name: 'createDunningPolicy',
    operationId: 'createDunningPolicy',
    permission: 'invoices.send',
    call: (s) =>
      createDunningPolicy(
        {
          name: 'Standard ladder',
          stages: [
            {
              stageNumber: 1,
              offsetDays: 7,
              subject: 'Payment reminder',
              body: 'Your invoice is overdue.',
              lateFeeMinor: null,
            },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'listDunningPolicies',
    operationId: 'listDunningPolicies',
    permission: 'invoices.read',
    call: (s) => listDunningPolicies({}, s.ctx),
  },
  {
    name: 'getDunningPolicy',
    operationId: 'getDunningPolicy',
    permission: 'invoices.read',
    call: (s) => getDunningPolicy(newUuid(), s.ctx),
  },
  {
    name: 'updateDunningPolicy',
    operationId: 'updateDunningPolicy',
    permission: 'invoices.send',
    call: (s) => updateDunningPolicy(newUuid(), { name: 'Edited' }, s.ctx),
  },
  {
    name: 'deactivateDunningPolicy',
    operationId: 'deactivateDunningPolicy',
    permission: 'invoices.send',
    call: (s) => deactivateDunningPolicy(newUuid(), s.ctx),
  },
  {
    name: 'runDueScheduledWork',
    operationId: 'runDueScheduledWork',
    permission: 'invoices.write',
    call: (s) => runDueWorkNow(s.ctx),
  },
  {
    name: 'getBankImportMapping',
    operationId: 'getBankImportMapping',
    permission: 'banking.read',
    call: (s) => getBankImportMapping(s.bankImportMappingId, s.ctx),
  },
  {
    name: 'listStatementLines',
    operationId: 'listStatementLines',
    permission: 'banking.read',
    call: (s) => listStatementLines({}, s.ctx),
  },
  {
    name: 'getStatementLine',
    operationId: 'getStatementLine',
    permission: 'banking.read',
    call: (s) => getStatementLine(s.statementLineId, s.ctx),
  },
  {
    name: 'proposeBankMatches',
    operationId: 'proposeBankMatches',
    permission: 'banking.read',
    call: (s) => proposeMatchesWithRules({ lineIds: [s.statementLineId] }, s.ctx),
  },
  // Clearing and un-clearing both reach `journals.post` after their own gate — a
  // clearing posts a journal, undoing one reverses it (D-16) — so a role holding
  // `banking.match` but not `journals.post` is refused there. No seeded role is, but
  // the downstream gate is declared so the prediction stays exact.
  {
    name: 'clearBankStatementLine',
    operationId: 'clearBankStatementLine',
    permission: 'banking.match',
    thenRequires: ['journals.post'],
    call: (s) =>
      clearBankStatementLine(
        s.statementLineId,
        { entries: [{ method: 'post_entry', accountId: s.expenseId }] },
        s.ctx,
      ),
  },
  {
    name: 'removeBankLineClearing',
    operationId: 'removeBankLineClearing',
    permission: 'banking.match',
    thenRequires: ['journals.post'],
    call: (s) => removeBankLineClearing(s.clearedStatementLineId, { date: s.date }, s.ctx),
  },
  {
    name: 'createBankRule',
    operationId: 'createBankRule',
    permission: 'banking.match',
    call: (s) =>
      createBankRule(
        {
          name: 'Tesco is groceries',
          condition: { description: { mode: 'contains', value: 'TESCO' } },
          outcome: { accountId: s.expenseId },
        },
        s.ctx,
      ),
  },
  {
    name: 'listBankRules',
    operationId: 'listBankRules',
    permission: 'banking.read',
    call: (s) => listBankRules({}, s.ctx),
  },
  {
    name: 'getBankRule',
    operationId: 'getBankRule',
    permission: 'banking.read',
    call: (s) => getBankRule(s.bankRuleId, s.ctx),
  },
  {
    name: 'updateBankRule',
    operationId: 'updateBankRule',
    permission: 'banking.match',
    call: (s) => updateBankRule(s.bankRuleId, { isActive: false }, s.ctx),
  },
  // The reconciliation reads gate on `banking.reconcile`, not `banking.read`, because
  // the service does — a reconciliation is not something a read-only role sees.
  {
    name: 'createReconciliationSession',
    operationId: 'createReconciliationSession',
    permission: 'banking.reconcile',
    call: (s) =>
      createReconciliationSession(
        { bankAccountId: s.bankAccountId, endDate: '2025-06-30', statementClosingBalance: '0' },
        s.ctx,
      ),
  },
  {
    name: 'listReconciliationSessions',
    operationId: 'listReconciliationSessions',
    permission: 'banking.reconcile',
    call: (s) => listReconciliationSessions({}, s.ctx),
  },
  {
    name: 'getReconciliationSession',
    operationId: 'getReconciliationSession',
    permission: 'banking.reconcile',
    call: (s) => getReconciliationSession(s.openReconciliationSessionId, s.ctx),
  },
  {
    name: 'updateReconciliationSession',
    operationId: 'updateReconciliationSession',
    permission: 'banking.reconcile',
    call: (s) =>
      updateReconciliationSession(
        s.openReconciliationSessionId,
        { statementClosingBalance: '0' },
        s.ctx,
      ),
  },
  // Ordered after `getReconciliationSession`/`updateReconciliationSession` above, which
  // read and edit the same open session: finalising it turns it `finalised`, so a
  // later edit would precondition-fail — still `allowed`, but the order keeps every
  // row a real success.
  {
    name: 'finaliseReconciliationSession',
    operationId: 'finaliseReconciliationSession',
    permission: 'banking.reconcile',
    call: (s) => finaliseReconciliationSession(s.openReconciliationSessionId, s.ctx),
  },
  {
    name: 'reopenReconciliationSession',
    operationId: 'reopenReconciliationSession',
    permission: 'banking.reopen',
    call: (s) =>
      reopenReconciliationSession(
        s.reconciliationSessionId,
        { reason: 'A cleared line was miscoded and needs correcting.' },
        s.ctx,
      ),
  },
  {
    name: 'getReconciliationReport',
    operationId: 'getReconciliationReport',
    permission: 'banking.read',
    call: (s) => getReconciliationReport(s.reconciliationSessionId, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // M5 (OB-097 … OB-104) — the platform surface: API keys, OAuth client
  // management, the change feed, external refs, and the agent review queue.
  //
  // Every id-addressed row below calls with `newUuid()` rather than a fixture the
  // Scene builds: the matrix only asks "did the gate refuse", and an operation
  // that gets past `requirePermission` and then 404s on a name nothing in this
  // org holds is still `allowed` — the same rule the file header states for a
  // precondition or a missing row. Not building dedicated fixtures for these
  // fifteen operations keeps this addition from touching `scene()`, which every
  // other row in this file also reads from.
  // ---------------------------------------------------------------------------
  {
    name: 'createApiKey',
    operationId: 'createApiKey',
    permission: 'api_keys.write',
    call: (s) =>
      createApiKey({ name: 'Nightly import job', roleId: SYSTEM_ROLE_UUIDS.bookkeeper }, s.ctx),
  },
  {
    name: 'listApiKeys',
    operationId: 'listApiKeys',
    permission: 'api_keys.read',
    call: (s) => listApiKeys({}, s.ctx),
  },
  {
    name: 'revokeApiKey',
    operationId: 'revokeApiKey',
    permission: 'api_keys.write',
    call: (s) => revokeApiKey(newUuid(), s.ctx),
  },
  {
    name: 'registerOAuthClient',
    operationId: 'registerOAuthClient',
    permission: 'integrations.write',
    call: (s) =>
      registerOAuthClient(
        { name: 'Zapier', redirectUris: ['https://example.com/oauth/callback'] },
        s.ctx,
      ),
  },
  {
    name: 'listOAuthClients',
    operationId: 'listOAuthClients',
    permission: 'integrations.read',
    call: (s) => listOAuthClients({}, s.ctx),
  },
  {
    name: 'deactivateOAuthClient',
    operationId: 'deactivateOAuthClient',
    permission: 'integrations.write',
    call: (s) => deactivateOAuthClient(newUuid(), s.ctx),
  },
  {
    name: 'listConnectedApps',
    operationId: 'listConnectedApps',
    permission: 'integrations.read',
    call: (s) => listConnectedApps({}, s.ctx),
  },
  {
    // Gated `integrations.read`, matching the service — `oauth.service.ts`'s
    // `revokeConnectedApp` header explains why: the caller can only ever reach
    // their own consent, so the code held is advisory rather than a write grant.
    name: 'revokeConnectedApp',
    operationId: 'revokeConnectedApp',
    permission: 'integrations.read',
    call: (s) => revokeConnectedApp(newUuid(), s.ctx),
  },
  {
    name: 'readChangeFeed',
    operationId: 'readChangeFeed',
    permission: 'integrations.read',
    call: (s) => readChangeFeed({}, s.ctx),
  },
  {
    name: 'createExternalRef',
    operationId: 'createExternalRef',
    permission: 'integrations.write',
    call: (s) =>
      createExternalRef(
        {
          externalSystem: 'quickbooks',
          entityType: 'contact',
          externalId: newUuid(),
          entityId: s.contactId,
        },
        s.ctx,
      ),
  },
  {
    name: 'listExternalRefs',
    operationId: 'listExternalRefs',
    permission: 'integrations.read',
    call: (s) => listExternalRefs({}, s.ctx),
  },
  {
    name: 'lookupExternalRef',
    operationId: 'lookupExternalRef',
    permission: 'integrations.read',
    call: (s) =>
      lookupExternalRef(
        { externalSystem: 'quickbooks', entityType: 'contact', externalId: newUuid() },
        s.ctx,
      ),
  },
  {
    name: 'listProposals',
    operationId: 'listProposals',
    permission: 'agents.review',
    call: (s) => listProposals({}, s.ctx),
  },
  {
    // `postDraft` re-checks `journals.post` (D-19); the seeded Approver role holds
    // both for exactly that reason (`review.service.ts`'s header).
    name: 'approveProposal',
    operationId: 'approveProposal',
    permission: 'agents.review',
    thenRequires: ['journals.post'],
    call: (s) => approveProposal(newUuid(), s.ctx),
  },
  {
    // `discardDraft` also re-checks `journals.post`, not just `journals.read` —
    // `drafts.service.ts`'s `discardDraft` and `review.service.ts`'s header both
    // state it.
    name: 'rejectProposal',
    operationId: 'rejectProposal',
    permission: 'agents.review',
    thenRequires: ['journals.post'],
    call: (s) => rejectProposal(newUuid(), s.ctx),
  },

  // ---------------------------------------------------------------------------
  // Payment integration (OB-150) — the five `connections.service.ts` operations.
  // Follows `bank-accounts.service.ts`'s connect/list/get/deactivate/reactivate
  // shape (that file's own header): `processing.write` gates connecting and the
  // two lifecycle writes, `processing.read` gates the two reads.
  // ---------------------------------------------------------------------------
  {
    name: 'connectProcessor',
    operationId: 'connectProcessor',
    permission: 'processing.write',
    call: (s) =>
      connectProcessor(
        {
          processor: 'fake',
          clearingAccountId: s.revenueId,
          feeAccountId: s.expenseId,
          secretKey: 'sk_test_row',
          webhookSecret: 'whsec_row',
        },
        s.ctx,
      ),
  },
  {
    name: 'listProcessorConnections',
    operationId: 'listProcessorConnections',
    permission: 'processing.read',
    call: (s) => listProcessorConnections(s.ctx),
  },
  {
    name: 'getProcessorConnection',
    operationId: 'getProcessorConnection',
    permission: 'processing.read',
    call: (s) => getProcessorConnection(s.processorConnectionId, s.ctx),
  },
  {
    name: 'deactivateProcessorConnection',
    operationId: 'deactivateProcessorConnection',
    permission: 'processing.write',
    call: (s) => deactivateProcessorConnection(s.processorConnectionId, s.ctx),
  },
  {
    name: 'reactivateProcessorConnection',
    operationId: 'reactivateProcessorConnection',
    permission: 'processing.write',
    call: (s) => reactivateProcessorConnection(s.processorConnectionId, s.ctx),
  },

  // ---------------------------------------------------------------------------
  // Cash application (OB-139) — payment terms, the discount-suggestion preview,
  // and the discount-account nominations beside `updateControlAccounts`. No new
  // catalog key: every operation below reuses `orgs.read`/`orgs.write`
  // (`terms.service.ts`'s own header — a term nomination is settings-like exactly
  // as the control accounts are) or the AR/AP document codes the suggestion reads
  // (`invoices.read`/`bills.read`).
  //
  // `suggestDiscount` is one route that splits on `targetType` the way
  // `recordPayment` splits on `direction` — `suggestion.service.ts` checks
  // `invoices.read` for an invoice target and `bills.read` for a bill one, so it
  // is two rows here for `recordPayment`'s own reason, and `suggestDiscount` joins
  // `DIRECTION_SPLIT_OPERATIONS` below rather than picking one side to assert.
  // ---------------------------------------------------------------------------

  {
    // A second term: `paymentTermId` in the scene is already named, and
    // `uq_payment_terms_org_name` refuses a duplicate name in one org.
    name: 'createPaymentTerm',
    operationId: 'createPaymentTerm',
    permission: 'orgs.write',
    call: (s) => createPaymentTerm({ name: '2/10 Net 30', netDays: 30 }, s.ctx),
  },
  {
    name: 'listPaymentTerms',
    operationId: 'listPaymentTerms',
    permission: 'orgs.read',
    call: (s) => listPaymentTerms(false, s.ctx),
  },
  {
    name: 'getPaymentTerm',
    operationId: 'getPaymentTerm',
    permission: 'orgs.read',
    call: (s) => getPaymentTerm(s.paymentTermId, s.ctx),
  },
  {
    name: 'updatePaymentTerm',
    operationId: 'updatePaymentTerm',
    permission: 'orgs.write',
    call: (s) => updatePaymentTerm(s.paymentTermId, { netDays: 45 }, s.ctx),
  },
  // Last of the three, since it archives the term the two rows above still need.
  {
    name: 'deactivatePaymentTerm',
    operationId: 'deactivatePaymentTerm',
    permission: 'orgs.write',
    call: (s) => deactivatePaymentTerm(s.paymentTermId, s.ctx),
  },
  {
    name: 'suggestDiscountInvoice',
    operationId: 'suggestDiscount',
    permission: 'invoices.read',
    call: (s) =>
      suggestDiscount(s.ctx, {
        targetType: 'invoice',
        targetId: s.targetInvoiceId,
        asOfDate: s.date,
      }),
  },
  {
    name: 'suggestDiscountBill',
    operationId: 'suggestDiscount',
    permission: 'bills.read',
    call: (s) =>
      suggestDiscount(s.ctx, { targetType: 'bill', targetId: s.targetBillId, asOfDate: s.date }),
  },
  {
    name: 'getDiscountAccounts',
    operationId: 'getDiscountAccounts',
    permission: 'orgs.read',
    call: (s) => getDiscountAccounts(s.ctx),
  },
  {
    name: 'updateDiscountAccounts',
    operationId: 'updateDiscountAccounts',
    permission: 'orgs.write',
    call: (s) =>
      updateDiscountAccounts(
        { discountGivenAccountId: s.expenseId, discountReceivedAccountId: s.revenueId },
        s.ctx,
      ),
  },

  // ---------------------------------------------------------------------------
  // Pay Bills (OB-111, OB-112, OB-115). The milestone whose whole point is a *real*
  // separation of duties (D-109). The headline: `buildPendingPayment` is allowed for
  // `ap_only` (it holds `pending_payments.write`) and `issuePendingPayment` is
  // refused for it — the same clerk can queue a payment and cannot release it. Issue
  // is judged on its one gate alone: `disbursements.issue` is owner-only, and owner
  // holds the downstream `payments_made.write`/`journals.post` too, so no role reaches
  // those second gates without the first — the id-based rows 404 past the gate rather
  // than materialising a payment, the `getBillCapture` shape every other id row uses.
  // ---------------------------------------------------------------------------
  {
    name: 'buildPendingPayment',
    operationId: 'buildPendingPayment',
    permission: 'pending_payments.write',
    call: (s) =>
      buildPendingPayment(
        {
          contactId: s.partyId,
          bankAccountId: s.bankAccountId,
          rail: 'check',
          intents: [{ billId: s.targetBillId, payAmount: '100' }],
        },
        s.ctx,
      ),
  },
  {
    name: 'payBills',
    operationId: 'payBills',
    permission: 'pending_payments.write',
    call: (s) =>
      payBills(
        {
          payments: [
            {
              contactId: s.partyId,
              bankAccountId: s.bankAccountId,
              rail: 'check',
              intents: [{ billId: s.targetBillId, payAmount: '100' }],
            },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'listPendingPayments',
    operationId: 'listPendingPayments',
    permission: 'pending_payments.read',
    call: (s) => listPendingPayments(s.ctx),
  },
  {
    name: 'getPendingPayment',
    operationId: 'getPendingPayment',
    permission: 'pending_payments.read',
    call: (s) => getPendingPayment(newUuid(), s.ctx),
  },
  {
    name: 'updatePendingPayment',
    operationId: 'updatePendingPayment',
    permission: 'pending_payments.write',
    call: (s) => updatePendingPayment(newUuid(), { memo: 'edited' }, s.ctx),
  },
  {
    name: 'cancelPendingPayment',
    operationId: 'cancelPendingPayment',
    permission: 'pending_payments.write',
    call: (s) => cancelPendingPayment(newUuid(), s.ctx),
  },
  {
    name: 'listPayableBills',
    operationId: 'listPayableBills',
    permission: 'pending_payments.read',
    call: (s) => listPayableBills(s.ctx),
  },
  {
    name: 'issuePendingPayment',
    operationId: 'issuePendingPayment',
    permission: 'disbursements.issue',
    call: (s) => issuePendingPayment(newUuid(), { date: s.date }, s.ctx),
  },
  {
    name: 'issuePendingPayments',
    operationId: 'issuePendingPayments',
    permission: 'disbursements.issue',
    call: (s) => issuePendingPayments({ pendingPaymentIds: [newUuid()], date: s.date }, s.ctx),
  },
  {
    name: 'listDisbursementsByRail',
    operationId: 'listDisbursementsByRail',
    permission: 'disbursements.issue',
    call: (s) => listDisbursementsByRail('check', s.ctx),
  },
  {
    name: 'getVendorDisbursementDetails',
    operationId: 'getVendorDisbursementDetails',
    permission: 'contacts.read',
    call: (s) => getVendorDisbursementDetails(s.contactId, s.ctx),
  },
  {
    name: 'updateVendorDisbursementDetails',
    operationId: 'updateVendorDisbursementDetails',
    permission: 'contacts.write',
    call: (s) =>
      updateVendorDisbursementDetails(s.contactId, { preferredPaymentRail: 'check' }, s.ctx),
  },
  // Fixed assets & recurring journals (initiative L, OB-162…167). Each id-taking read
  // passes a throwaway `newUuid()` — the 404 that follows is a non-permission error the
  // judge reads as `allowed`, so the row exercises the gate and nothing downstream.
  {
    name: 'createRecurringJournalTemplate',
    operationId: 'createRecurringJournalTemplate',
    permission: 'recurring_journals.write',
    call: (s) =>
      createRecurringJournalTemplate(
        {
          name: 'Monthly accrual',
          materializationMode: 'posted',
          frequency: 'monthly',
          intervalCount: 1,
          startDate: s.date,
          lines: [
            { accountId: s.cashId, side: 'debit', amount: '10000' },
            { accountId: s.revenueId, side: 'credit', amount: '10000' },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'getRecurringJournalTemplate',
    operationId: 'getRecurringJournalTemplate',
    permission: 'recurring_journals.read',
    call: (s) => getRecurringJournalTemplate(newUuid(), s.ctx),
  },
  {
    name: 'listRecurringJournalTemplates',
    operationId: 'listRecurringJournalTemplates',
    permission: 'recurring_journals.read',
    call: (s) => listRecurringJournalTemplates({}, s.ctx),
  },
  {
    name: 'updateRecurringJournalTemplate',
    operationId: 'updateRecurringJournalTemplate',
    permission: 'recurring_journals.write',
    call: (s) => updateRecurringJournalTemplate(newUuid(), { name: 'Renamed' }, s.ctx),
  },
  {
    name: 'deactivateRecurringJournalTemplate',
    operationId: 'deactivateRecurringJournalTemplate',
    permission: 'recurring_journals.write',
    call: (s) => deactivateRecurringJournalTemplate(newUuid(), s.ctx),
  },
  {
    name: 'registerFixedAsset',
    operationId: 'registerFixedAsset',
    permission: 'fixed_assets.write',
    call: (s) =>
      registerFixedAsset(
        {
          name: 'Laptop',
          assetAccountId: s.cashId,
          accumulatedDepreciationAccountId: s.cashId,
          depreciationExpenseAccountId: s.revenueId,
          acquisitionCostMinor: '120000',
          salvageValueMinor: '0',
          method: 'straight_line',
          usefulLifeMonths: 12,
          inServiceDate: s.date,
        },
        s.ctx,
      ),
  },
  {
    name: 'getFixedAsset',
    operationId: 'getFixedAsset',
    permission: 'fixed_assets.read',
    call: (s) => getFixedAsset(newUuid(), s.ctx),
  },
  {
    name: 'listFixedAssets',
    operationId: 'listFixedAssets',
    permission: 'fixed_assets.read',
    call: (s) => listFixedAssets({}, s.ctx),
  },
  {
    name: 'getFixedAssetSchedule',
    operationId: 'getFixedAssetSchedule',
    permission: 'fixed_assets.read',
    call: (s) => getFixedAssetSchedule(newUuid(), s.ctx),
  },
  {
    name: 'updateFixedAsset',
    operationId: 'updateFixedAsset',
    permission: 'fixed_assets.write',
    call: (s) => updateFixedAsset(newUuid(), { name: 'Renamed asset' }, s.ctx),
  },
  {
    name: 'disposeFixedAsset',
    operationId: 'disposeFixedAsset',
    permission: 'fixed_assets.write',
    call: (s) =>
      disposeFixedAsset(
        newUuid(),
        { date: s.date, proceedsMinor: '0', gainLossAccountId: s.revenueId },
        s.ctx,
      ),
  },
  // The org-default depreciation-account nominations (D-115) reuse `orgs.read`/`orgs.write`
  // — the same `getControlAccounts`/`updateDiscountAccounts` shape, a setup decision the
  // bookkeeper who runs the books does not make.
  {
    name: 'getDepreciationAccounts',
    operationId: 'getDepreciationAccounts',
    permission: 'orgs.read',
    call: (s) => getDepreciationAccounts(s.ctx),
  },
  {
    name: 'updateDepreciationAccounts',
    operationId: 'updateDepreciationAccounts',
    permission: 'orgs.write',
    call: (s) => updateDepreciationAccounts({ depreciationExpenseAccountId: s.revenueId }, s.ctx),
  },
  // ---------------------------------------------------------------------------
  // M — procure-to-pay (OB-170…179). Purchase orders and estimates are
  // non-posting pre-documents that convert into a bill/invoice; an employee
  // expense is an ap_documents bill against an employee contact. These rows
  // exercise the *gate*: a dummy id 404s (or, for createExpense against a vendor
  // fixture, precondition-fails on `requireEmployee`) past the permission check,
  // which is all this matrix asserts. The convert rows' downstream
  // `bills.write`/`invoices.write` gate and approveExpense's `journals.post` are
  // proven in the modules' own service suites.
  // ---------------------------------------------------------------------------
  {
    name: 'createPurchaseOrder',
    operationId: 'createPurchaseOrder',
    permission: 'purchase_orders.write',
    call: (s) =>
      createPurchaseOrder(
        {
          contactId: s.partyId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [{ description: 'Item', quantity: '1', unitAmount: '1000', accountId: s.cashId }],
        },
        s.ctx,
      ),
  },
  {
    name: 'listPurchaseOrders',
    operationId: 'listPurchaseOrders',
    permission: 'purchase_orders.read',
    call: (s) => listPurchaseOrders({}, s.ctx),
  },
  {
    name: 'getPurchaseOrder',
    operationId: 'getPurchaseOrder',
    permission: 'purchase_orders.read',
    call: (s) => getPurchaseOrder(newUuid(), s.ctx),
  },
  {
    name: 'updatePurchaseOrder',
    operationId: 'updatePurchaseOrder',
    permission: 'purchase_orders.write',
    call: (s) => updatePurchaseOrder(newUuid(), { memo: 'Renamed' }, s.ctx),
  },
  {
    name: 'approvePurchaseOrder',
    operationId: 'approvePurchaseOrder',
    permission: 'purchase_orders.write',
    call: (s) => approvePurchaseOrder(newUuid(), s.ctx),
  },
  {
    name: 'convertPurchaseOrderToBill',
    operationId: 'convertPurchaseOrderToBill',
    permission: 'purchase_orders.write',
    call: (s) => convertPurchaseOrderToBill(newUuid(), s.ctx),
  },
  {
    name: 'discardPurchaseOrder',
    operationId: 'discardPurchaseOrder',
    permission: 'purchase_orders.write',
    call: (s) => discardPurchaseOrder(newUuid(), s.ctx),
  },
  {
    name: 'createEstimate',
    operationId: 'createEstimate',
    permission: 'estimates.write',
    call: (s) =>
      createEstimate(
        {
          contactId: s.partyId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [
            { description: 'Item', quantity: '1', unitAmount: '1000', accountId: s.revenueId },
          ],
        },
        s.ctx,
      ),
  },
  {
    name: 'listEstimates',
    operationId: 'listEstimates',
    permission: 'estimates.read',
    call: (s) => listEstimates({}, s.ctx),
  },
  {
    name: 'getEstimate',
    operationId: 'getEstimate',
    permission: 'estimates.read',
    call: (s) => getEstimate(newUuid(), s.ctx),
  },
  {
    name: 'updateEstimate',
    operationId: 'updateEstimate',
    permission: 'estimates.write',
    call: (s) => updateEstimate(newUuid(), { memo: 'Renamed' }, s.ctx),
  },
  {
    name: 'approveEstimate',
    operationId: 'approveEstimate',
    permission: 'estimates.write',
    call: (s) => approveEstimate(newUuid(), s.ctx),
  },
  {
    name: 'convertEstimateToInvoice',
    operationId: 'convertEstimateToInvoice',
    permission: 'estimates.write',
    call: (s) => convertEstimateToInvoice(newUuid(), s.ctx),
  },
  {
    name: 'discardEstimate',
    operationId: 'discardEstimate',
    permission: 'estimates.write',
    call: (s) => discardEstimate(newUuid(), s.ctx),
  },
  {
    name: 'createExpense',
    operationId: 'createExpense',
    permission: 'expenses.write',
    call: (s) =>
      createExpense(
        {
          contactId: s.partyId,
          issueDate: s.date,
          taxMode: 'exclusive',
          lines: [{ description: 'Item', quantity: '1', unitAmount: '1000', accountId: s.cashId }],
        },
        s.ctx,
      ),
  },
  {
    name: 'listExpenses',
    operationId: 'listExpenses',
    permission: 'expenses.read',
    call: (s) => listExpenses({}, s.ctx),
  },
  {
    name: 'getExpense',
    operationId: 'getExpense',
    permission: 'expenses.read',
    call: (s) => getExpense(newUuid(), s.ctx),
  },
  {
    name: 'updateExpense',
    operationId: 'updateExpense',
    permission: 'expenses.write',
    call: (s) => updateExpense(newUuid(), { memo: 'Renamed' }, s.ctx),
  },
  {
    name: 'approveExpense',
    operationId: 'approveExpense',
    permission: 'expenses.approve',
    call: (s) => approveExpense(newUuid(), s.ctx),
  },
  {
    name: 'discardExpense',
    operationId: 'discardExpense',
    permission: 'expenses.write',
    call: (s) => discardExpense(newUuid(), s.ctx),
  },
  {
    name: 'sendPurchaseOrder',
    operationId: 'sendPurchaseOrder',
    permission: 'purchase_orders.write',
    call: (s) => sendPurchaseOrder(newUuid(), {}, s.ctx),
  },
  {
    name: 'sendEstimate',
    operationId: 'sendEstimate',
    permission: 'estimates.write',
    call: (s) => sendEstimate(newUuid(), {}, s.ctx),
  },
  // N — budgets (OB-181, OB-182). The three entry operations gate on
  // `budgets.read`/`budgets.write` (D-N6); the budget-vs-actual report gates on
  // `reports.read` like every other report, so its row's permission is that, not a
  // budgets key. Each call is judged the moment its own `requirePermission` passes,
  // so the `newUuid()` id and the throwaway account/period reach `allowed` for a
  // holder and a refusal for a non-holder.
  {
    name: 'setBudgets',
    operationId: 'setBudgets',
    permission: 'budgets.write',
    call: (s) =>
      setBudgets(
        { entries: [{ accountId: s.revenueId, periodId: s.periodId, amount: '0' }] },
        s.ctx,
      ),
  },
  {
    name: 'listBudgets',
    operationId: 'listBudgets',
    permission: 'budgets.read',
    call: (s) => listBudgets({}, s.ctx),
  },
  {
    name: 'deleteBudget',
    operationId: 'deleteBudget',
    permission: 'budgets.write',
    call: (s) => deleteBudget({ budgetId: newUuid() }, s.ctx),
  },
  {
    name: 'getBudgetVsActual',
    operationId: 'getBudgetVsActual',
    permission: 'reports.read',
    call: (s) => getBudgetVsActual({ periodId: s.periodId }, s.ctx),
  },
];

/** One line worth 1,000.00, on the revenue account an AR document credits. */
function arLine(s: Scene): {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly accountId: string;
} {
  return {
    description: 'Consulting',
    quantity: '1',
    unitAmount: '100000',
    accountId: s.revenueId,
  };
}

/** The payables mirror, on the expense account an AP document debits. */
function apLine(s: Scene): {
  readonly description: string;
  readonly quantity: string;
  readonly unitAmount: string;
  readonly accountId: string;
} {
  return {
    description: 'Paper',
    quantity: '1',
    unitAmount: '100000',
    accountId: s.expenseId,
  };
}

/**
 * The route operations that reach no `requirePermission` at all, and why.
 *
 * Every one of them either establishes an identity or acts on a credential the
 * caller already holds, so there is no role to check against yet: `resolveMembership`
 * and the invite token are the gate instead. Listed rather than filtered by a
 * pattern, so adding a route to this set is a deliberate edit that shows in a diff.
 */
const UNGATED_OPERATIONS: ReadonlySet<string> = new Set([
  // Liveness. It reaches no org and no role, which is the point of it.
  'getHealth',
  'register',
  'login',
  'logout',
  'getCurrentIdentity',
  // Membership, not permission: the token proves the invitation, and the caller is
  // not a member of the org yet, so no role exists to hold `members.write`.
  'acceptInvite',
  // Creating an org makes the caller its Owner; requiring a permission in an org
  // that does not exist is not expressible.
  'createOrg',
  // Both answer questions about the caller's own memberships, which is why
  // `resolveOrgMembership` — not a permission — is what converts "not a member" into
  // the A7 404.
  'listOrgMemberships',
  'switchActiveOrg',
  // The hosted invoice page (INV, OB-121, D-74): the capability token in the path is
  // the whole authorization, so these two carry no permission and reach no role —
  // the one sanctioned unauthenticated read on the API. See `public-invoices.ts`.
  'getPublicInvoiceView',
  'getPublicInvoicePdf',
  // The bill-capture inbound webhook (initiative O, OB-186): the per-org token in
  // the path is the whole authorization, exactly as the public-invoice pair above —
  // an unauthenticated push endpoint a mail relay hits, reaching no session and no
  // role. The captures it creates are attributed to the automation actor under the
  // org owner (`runAsAutomation`), not to the caller. See `bill-inbound.ts`.
  'receiveInboundBill',
  // The OAuth consent screen's data source (M5, OB-104): a logged-in user deciding whether
  // to delegate their OWN access is not an `integrations.*` admin act, so — like
  // `getCurrentIdentity` — it carries no permission and the session is its only gate.
  // `authorizeRequest` resolves the client through the caller's own org, so cross-org holds
  // without a permission row.
  'getOAuthAuthorizationDetails',
  // Payment integration (OB-150): the hosted invoice page's pay-link button, the same
  // capability-token shape as the public-invoice pair above — see `public-pay-link.ts`.
  'createPublicPayLink',
  // The processor webhook (OB-148): no session at all, `:connectionId` resolves the org
  // and the delivery's own signature is the authorization, not a permission — see
  // `processing-webhook.ts`.
  'receiveProcessorWebhook',
]);

/**
 * The four published operations that two rows above each exercise.
 *
 * A payment's direction is a property of the payment and not of the route:
 * `POST /v1/payments` carries `direction` in its body, and the other three resolve
 * it from the payment they name. `payments.service.ts` then checks
 * `payments_received.*` or `payments_made.*` — so one operation id has two
 * authorization outcomes, and one row could only ever assert one of them.
 *
 * Enumerated rather than deduplicated silently, which is the whole point of the
 * constant: the coverage check below compares the *set* of ids it covers against
 * the published document, and without this a second row accidentally carrying an
 * id another row already had — a copy-paste in a block of near-identical rows — is
 * invisible. A duplicate not on this list fails.
 */
const DIRECTION_SPLIT_OPERATIONS: readonly string[] = [
  'getPayment',
  'recordPayment',
  'suggestDiscount',
  'updatePayment',
  'voidPayment',
];

async function scene(role: SystemRoleName): Promise<Scene> {
  const org = await db.factories.org();
  const user = await db.factories.user();
  const other = await db.factories.user();
  await db.factories.orgMember({ orgId: org.id, userId: user.id, roleId: systemRoleId(role) });
  await db.factories.orgMember({ orgId: org.id, userId: other.id, roleId: systemRoleId('owner') });

  const period = await db.factories.fiscalPeriod({ orgId: org.id });
  const cash = await db.factories.account({
    orgId: org.id,
    code: '1000',
    type: 'asset',
    normalBalance: 'debit',
  });
  const revenue = await db.factories.account({
    orgId: org.id,
    code: '4000',
    type: 'revenue',
    normalBalance: 'credit',
  });

  /**
   * The two control accounts, the tax account, an expense account, and the bank a
   * payment moves money through.
   *
   * **The codes are deliberately not the shipped chart's `1100` and `2010`.**
   * Control accounts are a per-org nomination now (`modules/settings`) and no
   * service resolves one by code, so a fixture that used the conventional numbers
   * would keep passing if that resolution silently reverted — and the failure mode
   * matters here more than usual, because a control account that cannot be resolved
   * refuses *before* `postJournal` runs and every `journals.post` refusal this file
   * asserts would quietly become `allowed`.
   */
  const [receivable, payable, expense, bank, taxAccount] = await Promise.all([
    db.factories.account({
      orgId: org.id,
      code: '1150',
      name: 'Accounts receivable',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: org.id,
      code: '2050',
      name: 'Accounts payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
    db.factories.account({
      orgId: org.id,
      code: '5000',
      name: 'Office expenses',
      type: 'expense',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: org.id,
      code: '1010',
      name: 'Business checking',
      type: 'asset',
      normalBalance: 'debit',
    }),
    db.factories.account({
      orgId: org.id,
      code: '2100',
      name: 'VAT payable',
      type: 'liability',
      normalBalance: 'credit',
    }),
  ]);

  // A bank account is a ledger account plus import metadata (D-46), so it points at
  // `bank` rather than carrying a balance of its own. Inserted directly — there is
  // no bank-account factory or creation service yet (OB-084), and the setup context
  // here is always Owner regardless of the role under test.
  const bankAccountUuid = newUuid();
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: uuidToBuffer(bankAccountUuid),
      org_id: org.id,
      account_id: bank.id,
      name: 'Current account',
      external_account_id: null,
      is_active: 1,
    })
    .execute();

  // A second bank account carrying a finalised reconciliation session, so the
  // `banking.reopen` row has a session to reopen. It is a *different* account from
  // the one above because `createReconciliationSession` (the `banking.reconcile` row)
  // opens a session there, and reopening a finalised one turns it open too — two open
  // sessions on one account would collide on `open_marker`. Backed by `cash`, since
  // `uq_bank_accounts_account` allows a ledger account only one bank account.
  const reconciledBankAccountUuid = newUuid();
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: uuidToBuffer(reconciledBankAccountUuid),
      org_id: org.id,
      account_id: cash.id,
      name: 'Reconciled savings',
      external_account_id: null,
      is_active: 1,
    })
    .execute();

  const reconciliationSessionUuid = newUuid();
  await db.app
    .insertInto('reconciliation_sessions')
    .values({
      id: uuidToBuffer(reconciliationSessionUuid),
      org_id: org.id,
      bank_account_id: uuidToBuffer(reconciledBankAccountUuid),
      end_date: '2025-05-31',
      statement_closing_balance_minor: 0n,
      state: 'finalised',
      finalised_at: new Date(),
      created_by_user_id: user.id,
    })
    .execute();
  await db.app
    .insertInto('reconciliation_session_events')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: org.id,
      session_id: uuidToBuffer(reconciliationSessionUuid),
      event_type: 'finalised',
      asserted_balance_minor: 0n,
      created_by_user_id: user.id,
    })
    .execute();

  const journal = await db.factories.journal({
    orgId: org.id,
    periodId: period.id,
    entryDate: period.startDate,
    actorId: user.id,
    lines: [
      { accountId: cash.id, debitMinor: 150000n },
      { accountId: revenue.id, creditMinor: 150000n },
    ],
  });

  // `journal_lines.id` is a `BIGINT` the database allocates, so it is read back
  // rather than generated — the tagging surface addresses a line by it.
  const line = await db.app
    .selectFrom('journal_lines')
    .select('id')
    .where('org_id', '=', org.id)
    .where('journal_id', '=', journal.id)
    .orderBy('line_number')
    .executeTakeFirstOrThrow();

  /**
   * The rest is built through the services, as an Owner in the same org.
   *
   * Not through the factories: contacts, dimensions, and drafts have no factory,
   * and writing raw inserts for them here would mean this file carried its own idea
   * of what those rows look like. The setup context is always Owner regardless of
   * the role under test, so a role that cannot create a contact still has one to be
   * refused against — otherwise `getContact` for Read-only would be judged on a
   * missing row.
   */
  const setup = contextFor(org.uuid, SYSTEM_ROLE_UUIDS.owner, user.uuid);
  const contact = await createContact({ displayName: 'Acme Ltd' }, setup);
  const dimension = await createDimension({ code: 'DEPT', name: 'Department' }, setup);
  const value = await createDimensionValue(dimension.id, { code: 'SALES', name: 'Sales' }, setup);
  const draft = await createDraft({ entryDate: period.startDate, memo: 'Draft' }, setup);
  const discardable = await createDraft({ entryDate: period.startDate }, setup);
  const invite = await inviteMember(
    { email: `pending-${org.uuid}@openbooks.test`, roleId: SYSTEM_ROLE_UUIDS.readOnly },
    setup,
  );

  // The nomination, before anything can be approved. `orgs.write`, which is why it
  // is the Owner setup context doing it and not the role under test — an org whose
  // control accounts are unset refuses every approval with a precondition, and a
  // precondition reads `allowed` here.
  await updateControlAccounts(
    { receivableControlAccountId: receivable.uuid, payableControlAccountId: payable.uuid },
    setup,
  );

  const subledger = await subledgerFixtures(setup, {
    date: period.startDate,
    revenueId: revenue.uuid,
    expenseId: expense.uuid,
    bankId: bank.uuid,
    taxAccountId: taxAccount.uuid,
  });

  // --- OB-084 banking read/write fixtures ---
  //
  // Built as Owner (`setup`) where a service exists, and by direct insert where one does
  // not: a statement line is only ever created by an import (OB-078) and is append-only,
  // so the scene writes the import row and its lines directly rather than driving the
  // worker. Everything a read row names has to exist, or the row would read `allowed`
  // because it 404'd rather than because the gate let it through.
  const bankMapping = await saveBankImportMapping(
    bankAccountUuid,
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
    setup,
  );
  const bankRule = await createBankRule(
    {
      name: 'Coffee is subsistence',
      condition: { description: { mode: 'contains', value: 'COFFEE' } },
      outcome: { accountId: expense.uuid },
    },
    setup,
  );

  const bankImportUuid = newUuid();
  await db.app
    .insertInto('bank_statement_imports')
    .values({
      id: uuidToBuffer(bankImportUuid),
      org_id: org.id,
      bank_account_id: uuidToBuffer(bankAccountUuid),
      format: 'csv',
      filename: 'march.csv',
      file_hash: 'fixture',
      imported_by_user_id: user.id,
      status: 'complete',
      lines_read: 2,
      lines_duplicate: 0,
    })
    .execute();

  const statementLineUuid = newUuid();
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id: uuidToBuffer(statementLineUuid),
      org_id: org.id,
      bank_account_id: uuidToBuffer(bankAccountUuid),
      import_id: uuidToBuffer(bankImportUuid),
      // In the open fiscal period, so `clearBankStatementLine` posts rather than being
      // refused by the period lock (still not a `permission_denied`, but a real success
      // is a truer row).
      posted_date: period.startDate,
      description: 'COFFEE SHOP',
      amount_minor: -450n,
      fingerprint: 'fixture-uncleared',
      occurrence_index: 0,
    })
    .execute();

  // A second line already carrying a `post_entry` clearing, so `removeBankLineClearing`
  // has one to undo. The clearing points at the scene journal; undoing it reverses that
  // journal, which is the `journals.post` gate the row reaches after its own.
  const clearedLineUuid = newUuid();
  await db.app
    .insertInto('bank_statement_lines')
    .values({
      id: uuidToBuffer(clearedLineUuid),
      org_id: org.id,
      bank_account_id: uuidToBuffer(bankAccountUuid),
      import_id: uuidToBuffer(bankImportUuid),
      posted_date: period.startDate,
      description: 'BANK CHARGE',
      amount_minor: -1000n,
      fingerprint: 'fixture-cleared',
      occurrence_index: 0,
    })
    .execute();
  const clearedClearingId = newUuid();
  await db.app
    .insertInto('bank_line_clearings')
    .values({
      id: uuidToBuffer(clearedClearingId),
      org_id: org.id,
      statement_line_id: uuidToBuffer(clearedLineUuid),
      cleared_amount_minor: -1000n,
      difference_amount_minor: 0n,
      created_by_user_id: user.id,
    })
    .execute();
  // D-105: `method` and the coded journal moved off the parent onto the child.
  await db.app
    .insertInto('bank_line_clearing_entries')
    .values({
      id: uuidToBuffer(newUuid()),
      org_id: org.id,
      clearing_id: uuidToBuffer(clearedClearingId),
      entry_type: 'post_entry',
      cleared_journal_id: journal.id,
      account_id: revenue.id,
      entry_amount_minor: -1000n,
    })
    .execute();

  // A third bank account carrying an *open* session (D-45). Kept off the two accounts
  // above so finalising it — a mutating row — cannot collide with the session
  // `createReconciliationSession` opens on `bankAccountId` or the finalised one
  // `reopenReconciliationSession` reopens on the second: one open session per account
  // (`open_marker`). Backed by its own ledger account, since `uq_bank_accounts_account`
  // allows a ledger account only one bank account.
  const reconciling = await db.factories.account({
    orgId: org.id,
    code: '1030',
    name: 'Reconciling account',
    type: 'asset',
    normalBalance: 'debit',
  });
  const openBankAccountUuid = newUuid();
  await db.app
    .insertInto('bank_accounts')
    .values({
      id: uuidToBuffer(openBankAccountUuid),
      org_id: org.id,
      account_id: reconciling.id,
      name: 'Open recon account',
      external_account_id: null,
      is_active: 1,
    })
    .execute();
  // No `opened` event row: the DB `event_type` enum is `finalised`/`reopened` only, and
  // the `opened` event a session reports is synthesized on read from its creation. So an
  // open session is the row alone (matching what `createReconciliationSession` writes).
  const openSessionUuid = newUuid();
  await db.app
    .insertInto('reconciliation_sessions')
    .values({
      id: uuidToBuffer(openSessionUuid),
      org_id: org.id,
      bank_account_id: uuidToBuffer(openBankAccountUuid),
      end_date: '2025-06-30',
      statement_closing_balance_minor: 0n,
      state: 'in_progress',
      created_by_user_id: user.id,
    })
    .execute();

  // A spare ledger account with no bank account, for `createBankAccount` to register —
  // so its permitted call reaches the write rather than a 404.
  const registrable = await db.factories.account({
    orgId: org.id,
    code: '1020',
    name: 'Deposit account',
    type: 'asset',
    normalBalance: 'debit',
  });

  // --- OB-150 payment-processor fixture ---
  //
  // `revenue`/`expense` are nominated rather than dedicated accounts, the same way
  // `arLine`/`apLine` reuse them below — `connectProcessor` only reads whether an
  // account is active, so there is nothing for a fresh pair to prove that these two
  // do not already. `uq_processor_connections_org_processor` allows one `fake`
  // connection per org, which this scene fixture is; the `connectProcessor` row in
  // `OPERATIONS` nominates the same processor again, so a permitted caller's attempt
  // reaches `processor_already_connected` rather than a second row — a business-rule
  // refusal downstream of the gate, not a `permission_denied`, so it still reads
  // `allowed` (the same trade-off every fixture-collision row in this file makes).
  const processorConnection = await connectProcessor(
    {
      processor: 'fake',
      clearingAccountId: revenue.uuid,
      feeAccountId: expense.uuid,
      secretKey: 'sk_test_fixture',
      webhookSecret: 'whsec_fixture',
    },
    setup,
  );

  return {
    ...subledger,
    openReconciliationSessionId: openSessionUuid,
    bankImportMappingId: bankMapping.id,
    bankImportId: bankImportUuid,
    bankRuleId: bankRule.id,
    statementLineId: statementLineUuid,
    clearedStatementLineId: clearedLineUuid,
    registrableBankLedgerAccountId: registrable.uuid,
    processorConnectionId: processorConnection.id,
    receivableId: receivable.uuid,
    payableId: payable.uuid,
    expenseId: expense.uuid,
    bankId: bank.uuid,
    bankAccountId: bankAccountUuid,
    reconciliationSessionId: reconciliationSessionUuid,
    taxAccountId: taxAccount.uuid,
    ctx: contextFor(org.uuid, SYSTEM_ROLE_UUIDS[role], user.uuid),
    orgUuid: org.uuid,
    cashId: cash.uuid,
    revenueId: revenue.uuid,
    periodId: period.uuid,
    date: period.startDate,
    journalId: journal.uuid,
    journalLineId: String(line.id),
    contactId: contact.id,
    dimensionId: dimension.id,
    dimensionValueId: value.id,
    draftId: draft.id,
    discardableDraftId: discardable.id,
    inviteId: invite.invitation.id,
    otherUserId: other.uuid,
    actorId: user.uuid,
  };
}

/** The accounts M3's fixtures post against, resolved before any of them is built. */
interface SubledgerAccounts {
  readonly date: string;
  readonly revenueId: string;
  readonly expenseId: string;
  readonly bankId: string;
  readonly taxAccountId: string;
}

type SubledgerFixtures = Pick<
  Scene,
  | 'allocatableCreditNoteId'
  | 'allocatableVendorCreditId'
  | 'allocationId'
  | 'approvableBillId'
  | 'approvableCreditNoteId'
  | 'approvableInvoiceId'
  | 'approvableVendorCreditId'
  | 'deletableTaxRateId'
  | 'discardableBillId'
  | 'discardableCreditNoteId'
  | 'discardableInvoiceId'
  | 'discardableVendorCreditId'
  | 'draftBillId'
  | 'draftCreditNoteId'
  | 'draftInvoiceId'
  | 'draftVendorCreditId'
  | 'madePaymentId'
  | 'partyId'
  | 'paymentTermId'
  | 'receivedPaymentId'
  | 'targetBillId'
  | 'targetInvoiceId'
  | 'taxRateId'
  | 'voidableBillId'
  | 'voidableCreditNoteId'
  | 'voidableInvoiceId'
  | 'voidableMadePaymentId'
  | 'voidableReceivedPaymentId'
  | 'voidableVendorCreditId'
>;

/**
 * One org's worth of AR and AP, built by an Owner through the real services.
 *
 * Through the services and not through raw inserts, for the reason the setup block
 * above gives — but there is a second reason here that is stronger. An approved
 * document is a document *plus a journal plus a sequence number*, tied together by
 * `chk_ar_documents_approved`; a fixture that wrote the rows itself would be this
 * file's own idea of what approval means, and the first thing to diverge from the
 * service would be the thing every `void` row is judged against.
 *
 * Everything that posts runs inside `runInContext`, because `assertPostable` —
 * reached through `postJournal` — reads the ambient context rather than taking one
 * (spec §4 forbids threading `orgId` through signatures).
 */
async function subledgerFixtures(
  setup: RequestContext,
  accounts: SubledgerAccounts,
): Promise<SubledgerFixtures> {
  const asOwner = async <T>(body: () => Promise<T>): Promise<T> => runInContext(setup, body);

  // Both flags: one contact carries the invoices and the bills, because the AR
  // services refuse a non-customer and the AP services refuse a non-vendor.
  const party = await createContact(
    { displayName: 'Subledger Party', isCustomer: true, isVendor: true },
    setup,
  );

  const taxRate = await createTaxRate(
    { name: 'VAT 20%', percentage: '20', accountId: accounts.taxAccountId },
    setup,
  );
  // A second rate no document cites, because `deleteTaxRate` is refused for one
  // that is — and a refusal on those grounds reads `allowed` in this matrix.
  const deletableTaxRate = await createTaxRate(
    { name: 'Zero rated', percentage: '0', accountId: accounts.taxAccountId },
    setup,
  );

  // Cash application (OB-139): a simple term for `getPaymentTerm`/`updatePaymentTerm`/
  // `deactivatePaymentTerm` to be judged against.
  const paymentTerm = await createPaymentTerm({ name: 'Net 30', netDays: 30 }, setup);

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
  const arInput = {
    contactId: party.id,
    issueDate: accounts.date,
    taxMode: 'exclusive' as const,
    lines: arLines,
  };
  const billInput = { ...arInput, dueDate: accounts.date, lines: apLines };
  const vendorCreditInput = { ...arInput, lines: apLines };

  const invoice = async (): Promise<string> => (await createInvoice(arInput, setup)).id;
  const creditNote = async (): Promise<string> => (await createCreditNote(arInput, setup)).id;
  const bill = async (): Promise<string> => (await createBill(billInput, setup)).id;
  const vendorCredit = async (): Promise<string> =>
    (await createVendorCredit(vendorCreditInput, setup)).id;

  const approved = async (
    create: () => Promise<string>,
    approve: (id: string) => Promise<unknown>,
  ): Promise<string> => {
    const id = await create();
    await asOwner(() => approve(id));
    return id;
  };

  const targetInvoiceId = await approved(invoice, (id) => approveInvoice(id, setup));
  const targetBillId = await approved(bill, (id) => approveBill(id, setup));

  const payment = async (direction: 'made' | 'received'): Promise<string> =>
    (
      await asOwner(() =>
        recordPayment(
          {
            direction,
            contactId: party.id,
            date: accounts.date,
            // Ten times what anything applies, so the three allocation rows and the
            // fixture's own can all fit: over-allocating a *document* is refused
            // (C3), and that refusal would read `allowed`.
            amount: '100000',
            accountId: accounts.bankId,
          },
          setup,
        ),
      )
    ).id;

  const receivedPaymentId = await payment('received');
  const [allocation] = await asOwner(() =>
    allocatePayment(
      receivedPaymentId,
      { allocations: [{ targetType: 'invoice', targetId: targetInvoiceId, amount: '10000' }] },
      setup,
    ),
  );
  if (allocation === undefined) {
    throw new Error(
      'The fixture allocation was not written; every `deleteAllocation` row is void.',
    );
  }

  return {
    partyId: party.id,
    taxRateId: taxRate.id,
    deletableTaxRateId: deletableTaxRate.id,
    paymentTermId: paymentTerm.id,
    draftInvoiceId: await invoice(),
    discardableInvoiceId: await invoice(),
    approvableInvoiceId: await invoice(),
    voidableInvoiceId: await approved(invoice, (id) => approveInvoice(id, setup)),
    targetInvoiceId,
    draftCreditNoteId: await creditNote(),
    discardableCreditNoteId: await creditNote(),
    approvableCreditNoteId: await creditNote(),
    voidableCreditNoteId: await approved(creditNote, (id) => approveCreditNote(id, setup)),
    allocatableCreditNoteId: await approved(creditNote, (id) => approveCreditNote(id, setup)),
    draftBillId: await bill(),
    discardableBillId: await bill(),
    approvableBillId: await bill(),
    voidableBillId: await approved(bill, (id) => approveBill(id, setup)),
    targetBillId,
    draftVendorCreditId: await vendorCredit(),
    discardableVendorCreditId: await vendorCredit(),
    approvableVendorCreditId: await vendorCredit(),
    voidableVendorCreditId: await approved(vendorCredit, (id) => approveVendorCredit(id, setup)),
    allocatableVendorCreditId: await approved(vendorCredit, (id) => approveVendorCredit(id, setup)),
    receivedPaymentId,
    voidableReceivedPaymentId: await payment('received'),
    madePaymentId: await payment('made'),
    voidableMadePaymentId: await payment('made'),
    allocationId: allocation.id,
  };
}

/** `allowed`, or the exact permission the gate named when it refused. */
type Verdict = 'allowed' | `refused ${string}`;

async function judge(operation: Operation, built: Scene): Promise<Verdict> {
  try {
    await runInContext(built.ctx, () => operation.call(built));
    return 'allowed';
  } catch (error: unknown) {
    const wire = toWireError(error);
    if (wire.code !== 'permission_denied') return 'allowed';
    // Through `toWireError` rather than off the class, because what a caller can
    // distinguish is what reaches the wire — and the key is the whole payload a
    // `403` is permitted to carry (see `PermissionDeniedError`).
    const details = wire.details as { readonly permission?: string } | undefined;
    return `refused ${String(details?.permission)}`;
  }
}

/** A pass over every operation with one role's context. */
async function pass(role: SystemRoleName): Promise<Record<string, Verdict>> {
  const built = await scene(role);
  const verdicts: Record<string, Verdict> = {};
  for (const operation of OPERATIONS) {
    verdicts[operation.name] = await judge(operation, built);
  }
  return verdicts;
}

function expectedFor(role: SystemRoleName): Record<string, Verdict> {
  return Object.fromEntries(
    OPERATIONS.map((operation) => [operation.name, expectedVerdict(operation, role)]),
  );
}

/**
 * The first gate the role fails, or `allowed`.
 *
 * "First" is what makes this a prediction rather than a restatement: an
 * `approveInvoice` by an AR clerk must be refused with `journals.post` and not with
 * `invoices.write`, and getting the order wrong is exactly the mistake a matrix
 * that only compared allowed-versus-refused could not catch.
 */
function expectedVerdict(operation: Operation, role: SystemRoleName): Verdict {
  for (const key of gatesOf(operation)) {
    if (GRANTED_TO[key]?.includes(role) !== true) return `refused ${key}`;
  }
  return 'allowed';
}

describe('B10 — the permission matrix, at the service layer', () => {
  /**
   * The negative control, and the reason the six passes below are not vacuous.
   *
   * A role id naming no row resolves to the empty permission set — stated in
   * `requirePermission`'s own commentary as one of the degenerate cases that fail
   * closed. So every operation must refuse it, and must refuse it *with the key the
   * row declares*: that is what turns each `permission` field from a comment into an
   * assertion, and it is what would catch a service whose gate checks the wrong
   * code or has been deleted entirely.
   */
  it('refuses every operation to a role that holds nothing, naming the declared key', async () => {
    const built = await scene('owner');
    const nobody = { ...built, ctx: contextFor(built.orgUuid, newUuid(), built.otherUserId) };

    const verdicts: Record<string, Verdict> = {};
    for (const operation of OPERATIONS) {
      verdicts[operation.name] = await judge(operation, nobody);
    }

    expect(verdicts).toEqual(
      Object.fromEntries(
        OPERATIONS.map((operation) => [operation.name, `refused ${operation.permission}`]),
      ),
    );
  });

  // One test per role rather than one over all six: a failure should name the role,
  // and each pass builds its own org so a destructive operation in one cannot change
  // what another sees.
  it.each(ROLES)('%s is allowed exactly what the seeds grant it', async (role) => {
    expect(await pass(role)).toEqual(expectedFor(role));
  });

  /**
   * The converse of the matrix, by the same mechanism `cross-org.test.ts` uses:
   * compared against the *generated* OpenAPI document rather than a hand-kept list,
   * so an operation added to the API without a row here is named as uncovered before
   * it can ship unasserted.
   */
  it('covers every published operation that has a permission gate', async () => {
    const built = await buildTestApp();
    try {
      const document = JSON.parse(await generateOpenApiDocument(built.app)) as {
        paths: Record<string, Record<string, { operationId: string }>>;
      };

      const published = Object.values(document.paths)
        .flatMap((item) => Object.values(item).map((operation) => operation.operationId))
        .filter((operationId) => !UNGATED_OPERATIONS.has(operationId))
        .sort();

      const covered = OPERATIONS.map((operation) => operation.operationId).filter(
        (operationId): operationId is string => operationId !== null,
      );

      // Asserted before the set comparison, so a duplicate is reported as a
      // duplicate rather than disappearing into the `Set` below and leaving the
      // operation it displaced to be named as uncovered.
      const duplicated = covered.filter((id, index) => covered.indexOf(id) !== index).sort();
      expect(duplicated).toEqual([...DIRECTION_SPLIT_OPERATIONS].sort());

      expect([...new Set(covered)].sort()).toEqual(published);
    } finally {
      await built.app.close();
    }
  });

  /**
   * The same converse on the permission axis.
   *
   * Read out of the source rather than out of the matrix, because the matrix is
   * what is being checked: the set of codes any service actually enforces has to
   * equal the set the rows declare. A new enforcement point on a code no row names
   * — the shape M3's first invoice service will have — fails here, and the fix is
   * to add the row and move the code out of `LATENT_GRANTS`.
   *
   * `src/modules/permissions/` is excluded because it is where the mechanism is
   * defined: its commentary spells `requirePermission(ctx, 'invoices.write')` as
   * the example spec §5 gives, and a scan that counted the documentation would
   * report an enforcement point that does not exist.
   *
   * ## What M3 cost this scan, and why it was widened rather than narrowed
   *
   * Through M2 every enforcement point was a string literal, and a `\'([a-z_.]+)\'`
   * regex was the whole of it. OB-062 carries the AR lifecycle once and selects the
   * document type with `ArDocumentKind`, so its five calls read
   * `requirePermission(ctx, kind.writePermission)` — five real gates the old scan
   * could not see, which would have let `invoices.*` and `credit_notes.read` sit in
   * `GRANTED_TO` with nothing proving a service checks them.
   *
   * `payments.service.ts` took the other road and says so: "two literal
   * `requirePermission` calls rather than one on a computed key, so the enforcement
   * points stay greppable". That convention is the right one and OB-062 did not
   * follow it, so the scan resolves the indirection instead — one level, through the
   * constants declared in the *same module directory*, which is what `kinds.ts` is.
   * It over-approximates on purpose: `invoices.service.ts` alone enforces only
   * `invoices.*`, but the module as a whole enforces both kinds' codes, and a scan
   * that guessed which constant each file meant would be interpreting TypeScript.
   *
   * Anything it cannot resolve — a computed key, a context argument that is not
   * `ctx` — throws rather than being skipped. A scan that silently ignores what it
   * does not understand is how an enforcement point goes missing, which is the one
   * failure this test exists to make impossible.
   */
  it('names every permission any service enforces', () => {
    const enforced = new Set<string>();
    for (const file of serviceSources()) {
      for (const key of enforcementPointsIn(file)) enforced.add(key);
    }

    expect([...enforced].sort()).toEqual(Object.keys(GRANTED_TO).sort());
    expect([...new Set(OPERATIONS.flatMap(gatesOf))].sort()).toEqual(
      Object.keys(GRANTED_TO).sort(),
    );
  });
});

/**
 * **D-30 — drafting reuses `journals.post`, and Approver is the reason.**
 *
 * The matrix above already records `createDraft` and `postDraft` as `journals.post`,
 * but a matrix cannot say why that matters: swap the code for a hypothetical
 * `journals.draft` and every row above still passes, because a new code would land
 * in Owner and Bookkeeper by construction and those are the two roles a
 * write-shaped row is usually checked against.
 *
 * Approver is where the two answers differ. Its bundle is `%.read` plus a named few
 * including `journals.post`, so under D-30 it can compose a proposal and turn it
 * into a posting — which is the whole point of the role — and under a separate
 * draft code it could post an entry it was not allowed to write. Nothing else in
 * the suite would notice that change, so it is asserted end to end here: compose,
 * post, and read the journal back out of the ledger.
 */
describe('D-30 — Approver composes and posts a draft', () => {
  it('takes an Approver from an empty draft to a journal in the ledger', async () => {
    const built = await scene('approver');

    const composed = await runInContext(built.ctx, () =>
      createDraft(
        {
          entryDate: built.date,
          memo: 'Proposed by the approver',
          lines: [
            { accountId: built.cashId, side: 'debit', amount: '2500' },
            { accountId: built.revenueId, side: 'credit', amount: '2500' },
          ],
        },
        built.ctx,
      ),
    );

    // The edit, because "compose" is not one call: a proposal is worked on, and
    // `updateDraft` is the same permission for the same reason.
    await runInContext(built.ctx, () =>
      updateDraft(composed.id, { memo: 'Reviewed and approved' }, built.ctx),
    );

    const posted = await runInContext(built.ctx, () => postDraft(composed.id, built.ctx));

    const row = await db.app
      .selectFrom('journals')
      .select(['memo', 'source'])
      .where('id', '=', uuidToBuffer(posted.journalId))
      .executeTakeFirstOrThrow();
    expect(row.memo).toBe('Reviewed and approved');

    // And the boundary the role does *not* cross: an Approver reviews proposals, it
    // does not correct the ledger. `journals.reverse` is a separate code and is not
    // in the bundle, so the one write it can make is the one it was granted.
    await expect(
      runInContext(built.ctx, () =>
        reverseJournal(
          {
            journalId: posted.journalId,
            date: built.date,
            actorType: 'user',
            actorId: built.actorId,
          },
          built.ctx,
        ),
      ),
    ).rejects.toMatchObject({ details: { permission: 'journals.reverse' } });
  });
});

/**
 * **Known gap 6, written down.**
 *
 * The roadmap records it as a sentence: "the permission catalog seeds all 48 codes
 * including AR/AP, so when M3 lands a Bookkeeper gains invoice powers with no
 * migration and no audit event… the widening is invisible". This is what makes it
 * visible. `LATENT_GRANTS` is every code a role holds that no service checks, and
 * the only way for a code to leave one of these lists is for someone to write a
 * `requirePermission` for it — at which point the same commit must add the code to
 * `GRANTED_TO` and a row to `OPERATIONS`, or the two tests above fail.
 */
describe('gap 6 — the grants that nothing checks yet', () => {
  it('is exactly the catalog minus the forty-eight codes with an enforcement point', async () => {
    const catalog = await selectCatalogCodes();
    // Against the union rather than the type, so a code deleted from the seeds
    // without being deleted from the catalog union is caught here too.
    expect([...catalog].sort()).toEqual([...PERMISSION_KEYS].sort());

    const enforced = new Set(Object.keys(GRANTED_TO));
    const latent = catalog.filter((code) => !enforced.has(code)).sort();

    expect(latent).toEqual([...new Set(Object.values(LATENT_GRANTS).flat())].sort());
    // Thirty-one before M3, thirteen after it. M4 wired the banking codes over three
    // waves — `banking.import`/`banking.read` (eleven), `banking.match` (ten), then
    // `banking.reconcile`/`banking.reopen` (eight) — leaving only the M5/M6 codes and
    // the unscoped `api_keys.*`. OB-104 wired all five M5 codes at once, and OB-150
    // (initiative J, PAY) wired `processing.read`/`processing.write` the moment
    // `connections.service.ts` enforced them, leaving only
    // `workflows.activate`/`workflows.read`/`workflows.write` (M6). Initiative L's four
    // codes are NOT here: L's services enforce them (OB-162…166), so they are in
    // `GRANTED_TO` from the moment the service gates them, ahead of OB-167's routes.
    // This number is the only place the count is asserted rather than described, so it
    // moves once per wave that wires a code.
    //
    // Procure-to-pay (M) added seven codes and enforced them in the same milestone,
    // so they never lingered here past their one schema-only wave — the count is back
    // to the three `workflows.*` codes, still the only family with no milestone.
    expect(latent).toHaveLength(3);
  });

  /**
   * The two roles that emptied, called out separately from the per-role check
   * below.
   *
   * A role with nothing latent is the state the whole mechanism is aiming at, and
   * it is worth an assertion of its own because it is silent otherwise: the general
   * check would pass just as happily against `[]` produced by a deleted seed as
   * against `[]` produced by sixteen enforcement points arriving. So the count of
   * codes each clerk *holds* is asserted alongside it.
   */
  it.each([
    ['apOnly', 23],
    ['arOnly', 20],
  ] as const)('%s now holds %i codes and can exercise every one', async (role, held) => {
    const rows = await db.app
      .selectFrom('role_permissions')
      .select('permission_code')
      .where('role_id', '=', systemRoleId(role))
      .execute();

    expect(rows).toHaveLength(held);
    const enforced = new Set(Object.keys(GRANTED_TO));
    expect(rows.filter((row) => !enforced.has(row.permission_code))).toEqual([]);
  });

  it.each(ROLES)('%s holds these codes and can exercise none of them', async (role) => {
    const rows = await db.app
      .selectFrom('role_permissions')
      .select('permission_code')
      .where('role_id', '=', systemRoleId(role))
      .execute();

    const enforced = new Set(Object.keys(GRANTED_TO));
    const held = rows.map((row) => row.permission_code);

    expect(held.filter((code) => !enforced.has(code)).sort()).toEqual([...LATENT_GRANTS[role]]);
  });
});

/**
 * **The finding M3 produced, now fixed (OB-093).**
 *
 * `ar_only` and `ap_only` exist so that a clerk can run one subledger end to end.
 * They held the document codes for their side but not `journals.post`/
 * `journals.reverse`, and approving a document posts a journal, voiding one
 * reverses a journal, and recording a payment posts a journal — so the two roles
 * that exist to run AR and AP could not complete a single document between them.
 * `postJournal`/`reverseJournal` check the caller's own permission (the ledger
 * kernel authorizes its own writes, spec §2.4), which is the right design; the fix
 * was the seed, not the kernel. `0001_tenancy` now grants both clerks the two
 * codes, and the resolution was a decision about what a clerk is *for*: the role
 * exists to enter and finish AP/AR documents, so it must be able to post them.
 *
 * These tests now assert the completion end to end. `GRANTED_TO` names both clerks
 * on `journals.post`/`journals.reverse`, so the matrix rows for `approveInvoice`,
 * `voidInvoice`, `approveBill`, `voidBill`, `recordPayment` and their siblings
 * predict `allowed` for these roles; this block is the second, independent
 * statement of the same fact, at the service.
 */
describe('an AR or AP clerk finishes what they started (OB-093)', () => {
  it('lets an AR clerk write an invoice and issue it', async () => {
    const built = await scene('arOnly');

    const invoice = await runInContext(built.ctx, () =>
      createInvoice(
        {
          contactId: built.partyId,
          issueDate: built.date,
          taxMode: 'exclusive',
          lines: [arLine(built)],
        },
        built.ctx,
      ),
    );

    expect(invoice.status).toBe('draft');
    const approved = await runInContext(built.ctx, () => approveInvoice(invoice.id, built.ctx));
    expect(approved.status).toBe('approved');
  });

  it('lets an AR clerk void an invoice they hold `invoices.void` for', async () => {
    const built = await scene('arOnly');

    const voided = await runInContext(built.ctx, () =>
      voidInvoice(built.voidableInvoiceId, { date: built.date }, built.ctx),
    );
    expect(voided.status).toBe('void');
  });

  it('lets an AR clerk record the payment that settles their own invoice', async () => {
    const built = await scene('arOnly');

    const payment = await runInContext(built.ctx, () =>
      recordPayment(
        {
          direction: 'received',
          contactId: built.partyId,
          date: built.date,
          amount: '5000',
          accountId: built.bankId,
        },
        built.ctx,
      ),
    );
    expect(payment.status).toBe('recorded');
  });

  it('lets an AP clerk approve, void and record a payment', async () => {
    const built = await scene('apOnly');

    const approved = await runInContext(built.ctx, () =>
      approveBill(built.approvableBillId, built.ctx),
    );
    expect(approved.status).toBe('approved');

    const voided = await runInContext(built.ctx, () =>
      voidBill(built.voidableBillId, { date: built.date }, built.ctx),
    );
    expect(voided.status).toBe('void');

    const payment = await runInContext(built.ctx, () =>
      recordPayment(
        {
          direction: 'made',
          contactId: built.partyId,
          date: built.date,
          amount: '5000',
          accountId: built.bankId,
        },
        built.ctx,
      ),
    );
    expect(payment.status).toBe('recorded');
  });

  /**
   * Allocation posts nothing (D-37), so it worked even before OB-093 — kept to hold
   * the line that everything below the ledger was always allowed for a clerk.
   */
  it('lets an AR clerk allocate, because an allocation posts no journal', async () => {
    const built = await scene('arOnly');

    const allocations = await runInContext(built.ctx, () =>
      allocateCreditNote(
        built.allocatableCreditNoteId,
        {
          allocations: [
            { targetType: 'invoice', targetId: built.targetInvoiceId, amount: '10000' },
          ],
        },
        built.ctx,
      ),
    );

    expect(allocations).toHaveLength(1);
  });
});

/**
 * **The second finding: two codes the catalog does not hold.**
 *
 * `invoices.void` and `bills.void` exist; `credit_notes.void` and a `bills.approve`
 * of any kind do not. So voiding a credit note takes `credit_notes.write` and
 * approving a bill takes `bills.write`, which `invoices/kinds.ts` and
 * `bills/index.ts` each argue for on their own terms — and both arguments are
 * reasonable, and neither is checked by anything until here.
 *
 * Asserted against the *catalog* rather than restated as a comment, because the
 * cost of the arrangement is asymmetric: adding `credit_notes.void` later would
 * silently *narrow* every role that can currently void a credit note through
 * `credit_notes.write`, and nothing else in the system would notice. This test
 * makes that a change someone has to come here and make deliberately.
 */
describe('the codes the catalog does not hold, and what stands in for them', () => {
  it('holds a void code for the two documents that carry an amount owed, and no other', async () => {
    const catalog = new Set(await selectCatalogCodes());

    expect(catalog.has('invoices.void')).toBe(true);
    expect(catalog.has('bills.void')).toBe(true);
    expect(catalog.has('credit_notes.void')).toBe(false);
    expect(catalog.has('vendor_credits.void')).toBe(false);
    // No approve code of any kind: approval is the write, on all four documents.
    expect(catalog.has('bills.approve')).toBe(false);
    expect(catalog.has('invoices.approve')).toBe(false);
  });

  it('refuses the two operations with the `.write` code that stands in', async () => {
    // Read-only holds every `.read` and no `.write`, so the key it is refused with
    // is exactly the key each operation actually checks.
    const built = await scene('readOnly');

    await expect(
      runInContext(built.ctx, () =>
        voidCreditNote(built.voidableCreditNoteId, { date: built.date }, built.ctx),
      ),
    ).rejects.toMatchObject({ details: { permission: 'credit_notes.write' } });

    await expect(
      runInContext(built.ctx, () => approveBill(built.approvableBillId, built.ctx)),
    ).rejects.toMatchObject({ details: { permission: 'bills.write' } });
  });
});

const MODULES_DIR = fileURLToPath(new URL('../../src/modules/', import.meta.url));

interface ServiceSource {
  /** Absolute, and the scope in which an indirected key is resolved. */
  readonly directory: string;
  readonly source: string;
}

/**
 * Every module source that could hold an enforcement point.
 *
 * Not `*.service.ts` any more, and the widening is a finding of its own. That
 * filter held through M2 because every service file was named for the convention;
 * `modules/settings/control-accounts.ts` is not, and it carries the only two
 * `orgs.read` / `orgs.write` checks in the system. Under the old filter those two
 * gates were invisible, so the codes could have been declared in `GRANTED_TO` with
 * nothing proving a service checked them — or, worse, left latent while a service
 * quietly enforced them.
 *
 * A naming convention is the wrong thing for an exhaustiveness check to depend on:
 * it fails open, silently, and only for files somebody named differently. Reading
 * every `.ts` under `src/modules` costs nothing (repositories contain no
 * `requirePermission`, so they contribute nothing) and cannot fail that way.
 */
function serviceSources(): readonly ServiceSource[] {
  return readdirSync(MODULES_DIR, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .filter((name) => !name.startsWith('permissions'))
    .map((name) => ({
      directory: join(MODULES_DIR, dirname(name)),
      source: readFileSync(join(MODULES_DIR, name), 'utf8'),
    }));
}

/**
 * Every `requirePermission` call in one service file, deliberately naive about
 * *nothing*.
 *
 * `[^)]*` rather than a shape, so a call this scan cannot interpret is found and
 * then rejected, instead of failing to match and being counted as absent.
 */
const REQUIRE_PERMISSION = /requirePermission\(\s*([^)]*?)\s*\)/g;
const LITERAL_KEY = /^'([a-z_.]+)'$/;
const MEMBER_KEY = /^[A-Za-z_$][\w$]*\.([\w$]+)$/;

function enforcementPointsIn(file: ServiceSource): readonly string[] {
  const keys: string[] = [];

  for (const match of file.source.matchAll(REQUIRE_PERMISSION)) {
    const args = match[1] ?? '';
    const comma = args.indexOf(',');
    const context = args.slice(0, comma).trim();
    const key = args.slice(comma + 1).trim();

    // The context argument is checked as well as the key. Every service in the
    // codebase names it `ctx`, and a call that named it something else would slip
    // past a scan keyed on the literal — an enforcement point invisible to the one
    // test whose job is to see all of them.
    if (comma === -1 || context !== 'ctx') {
      throw new Error(
        `Unreadable enforcement point in ${file.directory}: requirePermission(${args}). ` +
          'The matrix reads the enforced key set out of the source; a call it cannot parse is a ' +
          'gate no exhaustiveness check can see. Pass the context as `ctx`.',
      );
    }

    const literal = LITERAL_KEY.exec(key)?.[1];
    if (literal !== undefined) {
      keys.push(literal);
      continue;
    }

    const property = MEMBER_KEY.exec(key)?.[1];
    if (property === undefined) {
      throw new Error(
        `Computed permission key in ${file.directory}: requirePermission(ctx, ${key}). ` +
          'Use a literal, as `payments.service.ts` does deliberately, or a constant declared in ' +
          'the same module directory — anything else is an enforcement point this matrix is ' +
          'blind to.',
      );
    }

    keys.push(...permissionConstants(file.directory, property));
  }

  return keys;
}

/**
 * Every code assigned to `property` by a constant in `directory`.
 *
 * One level, no imports followed, and only within the module — `ArDocumentKind`'s
 * two instances live beside the service that reads them, which is what makes the
 * resolution tractable at all. Empty is an error rather than an empty set: a
 * property that resolves to nothing is a gate that silently disappeared from the
 * enforced set.
 */
function permissionConstants(directory: string, property: string): readonly string[] {
  const assignment = new RegExp(`\\b${property}:\\s*'([a-z_.]+)'`, 'g');
  const codes: string[] = [];

  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.ts') || name.endsWith('.service.ts')) continue;
    for (const match of readFileSync(join(directory, name), 'utf8').matchAll(assignment)) {
      const code = match[1];
      if (code !== undefined) codes.push(code);
    }
  }

  if (codes.length === 0) {
    throw new Error(
      `\`${property}\` is enforced in ${directory} and no constant there declares it. The key ` +
        'set this matrix checks is read from the source, so an unresolvable indirection hides a ' +
        'permission rather than failing loudly.',
    );
  }

  return codes;
}
